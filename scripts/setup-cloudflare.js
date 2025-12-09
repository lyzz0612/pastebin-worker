#!/usr/bin/env node
/**
 * setup-cloudflare.js
 * @description 自动配置 Cloudflare KV 和 R2 资源的 Node.js 脚本
 *              用于 GitHub Actions 部署流程，跨平台兼容
 *
 * 环境变量:
 *   CLOUDFLARE_API_TOKEN - Cloudflare API Token (必需)
 *   CLOUDFLARE_ACCOUNT_ID - Cloudflare Account ID (必需)
 *   WORKER_NAME - Worker 名称 (默认: pb)
 *   KV_NAMESPACE_NAME - KV 命名空间名称 (默认: PB)
 *   R2_BUCKET_NAME - R2 存储桶名称 (默认: pb-storage, 留空则跳过 R2)
 *   DEPLOY_URL - 部署 URL (可选)
 *   GITHUB_OUTPUT - GitHub Actions 输出文件 (自动设置)
 */

import { spawnSync } from "child_process"
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs"
import { resolve } from "path"

// 配置
const CONFIG = {
  workerName: process.env.WORKER_NAME || "pb",
  kvNamespaceName: process.env.KV_NAMESPACE_NAME || "PB",
  r2BucketName: process.env.R2_BUCKET_NAME || "pb-storage",
  outputFile: process.env.GITHUB_OUTPUT || null,
  deployUrl: process.env.DEPLOY_URL || null,
  skipR2: !process.env.R2_BUCKET_NAME || process.env.SKIP_R2 === "true",
}

// 颜色输出
const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
}

function log(level, message) {
  const prefix = {
    info: `${colors.green}[INFO]${colors.reset}`,
    warn: `${colors.yellow}[WARN]${colors.reset}`,
    error: `${colors.red}[ERROR]${colors.reset}`,
    debug: `${colors.blue}[DEBUG]${colors.reset}`,
  }
  console.log(`${prefix[level] || "[LOG]"} ${message}`)
}

// 写入 GitHub Actions 输出
function writeOutput(key, value) {
  if (CONFIG.outputFile) {
    appendFileSync(CONFIG.outputFile, `${key}=${value}\n`)
  }
  log("info", `Output: ${key}=${value}`)
}

// 执行 wrangler 命令
function runWrangler(args, options = {}) {
  const cmd = process.platform === "win32" ? "npx.cmd" : "npx"
  const fullArgs = ["wrangler", ...args]

  log("debug", `执行命令: ${cmd} ${fullArgs.join(" ")}`)

  const result = spawnSync(cmd, fullArgs, {
    encoding: "utf-8",
    shell: true,
    ...options,
  })

  return {
    success: result.status === 0,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status,
  }
}

// 获取现有的 KV 命名空间列表
function listKVNamespaces() {
  const result = runWrangler(["kv", "namespace", "list"])
  if (!result.success) {
    log("warn", "无法获取 KV 命名空间列表")
    return []
  }

  try {
    // wrangler 输出可能包含额外信息，尝试解析 JSON
    const jsonMatch = result.stdout.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
    return JSON.parse(result.stdout)
  } catch {
    log("debug", `KV 列表解析失败: ${result.stdout}`)
    return []
  }
}

// 创建 KV 命名空间
function createKVNamespace(name) {
  log("info", `创建 KV 命名空间: ${name}`)
  const result = runWrangler(["kv", "namespace", "create", name])

  if (!result.success) {
    log("error", `创建 KV 命名空间失败: ${result.stderr}`)
    return null
  }

  // 从输出中提取 ID
  // 格式可能是: id = "xxx" 或 "id": "xxx"
  const idMatch =
    result.stdout.match(/id\s*=\s*"([^"]+)"/) ||
    result.stdout.match(/"id"\s*:\s*"([^"]+)"/) ||
    result.stderr.match(/id\s*=\s*"([^"]+)"/)

  if (idMatch) {
    return idMatch[1]
  }

  log("warn", `无法从输出中提取 ID: ${result.stdout}`)
  return null
}

// 设置 KV 命名空间
function setupKVNamespace() {
  log("info", "检查 KV 命名空间...")

  const namespaces = listKVNamespaces()
  const targetNames = [`${CONFIG.workerName}-${CONFIG.kvNamespaceName}`, CONFIG.kvNamespaceName]

  // 查找现有命名空间
  for (const ns of namespaces) {
    if (targetNames.includes(ns.title)) {
      log("info", `找到现有 KV 命名空间: ${ns.title} (${ns.id})`)
      writeOutput("kv_id", ns.id)
      return ns.id
    }
  }

  // 创建新命名空间
  const newId = createKVNamespace(CONFIG.kvNamespaceName)
  if (newId) {
    log("info", `KV 命名空间创建成功: ${newId}`)
    writeOutput("kv_id", newId)
    return newId
  }

  throw new Error("无法创建 KV 命名空间")
}

// 获取现有的 R2 存储桶列表
function listR2Buckets() {
  const result = runWrangler(["r2", "bucket", "list"])
  if (!result.success) {
    log("warn", "无法获取 R2 存储桶列表，可能 R2 未启用")
    return null // null 表示 R2 不可用
  }

  try {
    const jsonMatch = result.stdout.match(/\[[\s\S]*\]/)
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0])
    }
    return JSON.parse(result.stdout)
  } catch {
    // 如果不是 JSON，可能是空列表或其他格式
    log("debug", `R2 列表解析: ${result.stdout}`)
    return []
  }
}

// 创建 R2 存储桶
function createR2Bucket(name) {
  log("info", `创建 R2 存储桶: ${name}`)
  const result = runWrangler(["r2", "bucket", "create", name])

  if (result.success) {
    return true
  }

  // 检查是否是因为已存在
  if (result.stderr.includes("already exists") || result.stdout.includes("already exists")) {
    log("info", "存储桶已存在")
    return true
  }

  log("warn", `创建 R2 存储桶失败: ${result.stderr || result.stdout}`)
  return false
}

// 设置 R2 存储桶
function setupR2Bucket() {
  // 检查是否跳过 R2
  if (CONFIG.skipR2) {
    log("info", "跳过 R2 配置 (SKIP_R2=true 或 R2_BUCKET_NAME 为空)")
    writeOutput("r2_enabled", "false")
    writeOutput("r2_bucket_name", "")
    return { enabled: false, bucketName: "" }
  }

  log("info", "检查 R2 存储桶...")

  const buckets = listR2Buckets()

  // 如果无法获取列表，说明 R2 不可用
  if (buckets === null) {
    log("warn", "R2 服务不可用，将禁用 R2 功能")
    log("warn", "提示: 请确保您的 Cloudflare 账户已启用 R2，且 API Token 有 R2 权限")
    writeOutput("r2_enabled", "false")
    writeOutput("r2_bucket_name", "")
    return { enabled: false, bucketName: "" }
  }

  // 查找现有存储桶
  const existing = buckets.find((b) => b.name === CONFIG.r2BucketName)
  if (existing) {
    log("info", `找到现有 R2 存储桶: ${CONFIG.r2BucketName}`)
    writeOutput("r2_enabled", "true")
    writeOutput("r2_bucket_name", CONFIG.r2BucketName)
    return { enabled: true, bucketName: CONFIG.r2BucketName }
  }

  // 尝试创建新存储桶
  if (createR2Bucket(CONFIG.r2BucketName)) {
    log("info", `R2 存储桶创建成功: ${CONFIG.r2BucketName}`)
    writeOutput("r2_enabled", "true")
    writeOutput("r2_bucket_name", CONFIG.r2BucketName)
    return { enabled: true, bucketName: CONFIG.r2BucketName }
  }

  log("warn", "无法创建 R2 存储桶，将禁用 R2 功能")
  log("warn", "大文件上传将受到限制 (最大 R2_THRESHOLD)")
  writeOutput("r2_enabled", "false")
  writeOutput("r2_bucket_name", "")
  return { enabled: false, bucketName: "" }
}

// 更新 wrangler.toml 配置
function updateWranglerConfig(kvId, r2Config) {
  const configPath = resolve(process.cwd(), "wrangler.toml")

  if (!existsSync(configPath)) {
    throw new Error("wrangler.toml 文件不存在")
  }

  log("info", "更新 wrangler.toml 配置...")

  let content = readFileSync(configPath, "utf-8")

  // 更新 KV ID
  // 匹配 [[kv_namespaces]] 块中的 id
  content = content.replace(/(^\[\[kv_namespaces\]\][\s\S]*?^id\s*=\s*)"[^"]*"/m, `$1"${kvId}"`)

  // 处理 R2 配置
  if (r2Config.enabled && r2Config.bucketName) {
    log("info", "启用 R2 配置...")

    // 检查是否有被注释的 R2 配置
    if (content.includes("# [[r2_buckets]]")) {
      // 取消注释并更新
      content = content.replace(/# \[\[r2_buckets\]\]/g, "[[r2_buckets]]")
      content = content.replace(/# binding = "R2"/g, 'binding = "R2"')
      content = content.replace(/# bucket_name = "[^"]*"/g, `bucket_name = "${r2Config.bucketName}"`)
    } else if (!content.includes("[[r2_buckets]]")) {
      // 如果没有 R2 配置，添加新的
      const r2Section = `
# R2 bucket for large file storage (auto-configured)
[[r2_buckets]]
binding = "R2"
bucket_name = "${r2Config.bucketName}"
`
      // 在 [vars] 之前插入
      content = content.replace(/(\n\[vars\])/, `${r2Section}$1`)
    } else {
      // 更新现有的 bucket_name
      content = content.replace(/(^\[\[r2_buckets\]\][\s\S]*?^bucket_name\s*=\s*)"[^"]*"/m, `$1"${r2Config.bucketName}"`)
    }
  } else {
    log("info", "禁用 R2 配置...")
    // 注释掉 R2 配置
    content = content.replace(/^(\[\[r2_buckets\]\])/gm, "# $1")
    content = content.replace(/^(binding = "R2")/gm, "# $1")
    content = content.replace(/^(bucket_name = )/gm, "# $1")
  }

  // 如果提供了 DEPLOY_URL，更新它
  if (CONFIG.deployUrl) {
    content = content.replace(/(DEPLOY_URL\s*=\s*)"[^"]*"/, `$1"${CONFIG.deployUrl}"`)
  }

  writeFileSync(configPath, content)
  log("info", "wrangler.toml 配置已更新")
}

// 验证配置
function verifyConfig() {
  log("info", "验证配置...")

  const configPath = resolve(process.cwd(), "wrangler.toml")
  const content = readFileSync(configPath, "utf-8")

  // 检查 KV ID 是否已设置
  if (content.match(/^\[\[kv_namespaces\]\][\s\S]*?^id\s*=\s*""/m)) {
    throw new Error("KV 命名空间 ID 未设置")
  }

  log("info", "配置验证通过")
}

// 检查必需的环境变量
function checkRequiredEnvVars() {
  const required = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]
  const missing = required.filter((v) => !process.env[v])

  if (missing.length > 0) {
    log("error", `缺少必需的环境变量: ${missing.join(", ")}`)
    log("error", "请在 GitHub Secrets 中配置 CF_API_TOKEN 和 CF_ACCOUNT_ID")
    return false
  }
  return true
}

// 主函数
async function main() {
  console.log("")
  log("info", "=========================================")
  log("info", "Cloudflare 资源自动配置脚本")
  log("info", "=========================================")
  console.log("")

  try {
    // 检查环境变量
    if (!checkRequiredEnvVars()) {
      process.exit(1)
    }

    // 检查 wrangler
    const versionResult = runWrangler(["--version"])
    if (!versionResult.success) {
      throw new Error("wrangler 未安装或不可用")
    }
    log("info", `wrangler 版本: ${versionResult.stdout.trim()}`)

    // 显示配置
    log("info", `Worker 名称: ${CONFIG.workerName}`)
    log("info", `KV 命名空间: ${CONFIG.kvNamespaceName}`)
    log("info", `R2 存储桶: ${CONFIG.skipR2 ? "(跳过)" : CONFIG.r2BucketName}`)
    console.log("")

    // 设置 KV
    const kvId = setupKVNamespace()

    // 设置 R2
    const r2Config = setupR2Bucket()

    // 更新配置
    updateWranglerConfig(kvId, r2Config)

    // 验证
    verifyConfig()

    console.log("")
    log("info", "=========================================")
    log("info", "配置完成!")
    log("info", `KV ID: ${kvId}`)
    log("info", `R2 启用: ${r2Config.enabled}`)
    if (r2Config.bucketName) {
      log("info", `R2 存储桶: ${r2Config.bucketName}`)
    }
    log("info", "=========================================")
    console.log("")
  } catch (error) {
    log("error", error.message)
    process.exit(1)
  }
}

main()

