import { verifyAuth } from "../pages/auth.js"
import { decode, genRandStr, WorkerError } from "../common.js"
import { createPaste, getPasteMetadata, pasteNameAvailable, updatePaste, isR2Available } from "../storage/storage.js"
import {
  DEFAULT_PASSWD_LEN,
  NAME_REGEX,
  PASTE_NAME_LEN,
  PRIVATE_PASTE_NAME_LEN,
  PASSWD_SEP,
  MIN_PASSWD_LEN,
  MAX_PASSWD_LEN,
} from "../../shared/constants.js"
import { parsePath, parseSize, parseExpiration, PERMANENT_EXPIRATION } from "../../shared/parsers.js"
import { PasteResponse } from "../../shared/interfaces.js"
import { MaxFileSizeExceededError, MultipartParseError, parseMultipartRequest } from "@mjackson/multipart-parser"
import { handleMPUComplete, handleMPUCreate, handleMPUCreateUpdate, handleMPUResume } from "./handleMPU.js"

type ParsedMultipartPart = {
  filename?: string
  content: ReadableStream | ArrayBuffer
  contentAsString: () => string
  contentLength: number
}

async function multipartToMap(req: Request, sizeLimit: number): Promise<Map<string, ParsedMultipartPart>> {
  const partsMap = new Map<string, ParsedMultipartPart>()
  try {
    await parseMultipartRequest(req, { maxFileSize: sizeLimit }, async (part) => {
      if (part.name) {
        if (part.isFile) {
          const arrayBuffer = await part.arrayBuffer()
          partsMap.set(part.name, {
            filename: part.filename,
            content: arrayBuffer,
            contentLength: arrayBuffer.byteLength,
            contentAsString: () => decode(arrayBuffer),
          })
        } else {
          const arrayBuffer = await part.arrayBuffer()
          partsMap.set(part.name, {
            filename: part.filename,
            content: arrayBuffer,
            contentAsString: () => decode(arrayBuffer),
            contentLength: arrayBuffer.byteLength,
          })
        }
      }
    })
  } catch (err) {
    if (err instanceof MaxFileSizeExceededError) {
      throw new WorkerError(413, `payload too large (max ${sizeLimit} bytes allowed)`)
    } else if (err instanceof MultipartParseError) {
      console.error(err)
      throw new WorkerError(400, "Failed to parse multipart request")
    } else {
      throw err
    }
  }
  return partsMap
}

export async function handlePostOrPut(
  request: Request,
  env: Env,
  _: ExecutionContext,
  isPut: boolean,
): Promise<Response> {
  if (!isPut) {
    // only POST requires auth, since PUT request already contains auth
    const authResponse = verifyAuth(request, env)
    if (authResponse !== null) {
      return authResponse
    }
  }

  const url = new URL(request.url)

  let isMPUComplete = false
  // MPU (Multipart Upload) requires R2
  if (url.pathname.startsWith("/mpu/")) {
    if (!isR2Available(env)) {
      throw new WorkerError(
        400,
        "Multipart upload requires R2 storage, but R2 is not configured. Please use regular upload for files smaller than " +
          env.R2_THRESHOLD,
      )
    }
    if (url.pathname === "/mpu/create" && !isPut) {
      return handleMPUCreate(request, env)
    } else if (url.pathname === "/mpu/create-update" && !isPut) {
      return handleMPUCreateUpdate(request, env)
    } else if (url.pathname === "/mpu/resume" && isPut) {
      return handleMPUResume(request, env)
    } else if (url.pathname === "/mpu/complete") {
      isMPUComplete = true // we will handle mpu complete later since it is uploaded with formdata
    } else {
      throw new WorkerError(400, "illegal mpu operation")
    }
  }

  const contentType = request.headers.get("Content-Type") || ""

  // parse formdata
  if (!contentType.includes("multipart/form-data")) {
    throw new WorkerError(400, `bad usage, please use 'multipart/form-data' instead of ${contentType}`)
  }

  // If R2 is not available, limit file size to R2_THRESHOLD
  const maxFileSize = isR2Available(env) ? parseSize(env.R2_MAX_ALLOWED)! : parseSize(env.R2_THRESHOLD)!
  const parts = await multipartToMap(request, maxFileSize)

  if (!parts.has("c")) {
    throw new WorkerError(400, "cannot find content in formdata")
  }
  const { filename, content, contentAsString, contentLength } = parts.get("c")!
  const nameFromForm = parts.get("n")?.contentAsString()
  const isPrivate = parts.has("p")
  const passwdFromForm = parts.get("s")?.contentAsString()
  const expireFromForm: string | undefined = parts.get("e")?.contentAsString()
  const encryptionScheme: string | undefined = parts.get("encryption-scheme")?.contentAsString()
  const highlightLanguage = parts.get("lang")?.contentAsString()
  const expire = expireFromForm ? expireFromForm : env.DEFAULT_EXPIRATION

  const uploadedParts = isMPUComplete ? (JSON.parse(contentAsString()) as R2UploadedPart[]) : undefined

  // parse expiration
  let expirationSeconds = parseExpiration(expire)
  if (expirationSeconds === null) {
    throw new WorkerError(400, `‘${expire}’ is not a valid expiration specification`)
  }
  const maxExpiration = parseExpiration(env.MAX_EXPIRATION)!
  if (expirationSeconds > maxExpiration) {
    expirationSeconds = maxExpiration
  }

  // check if password is legal
  // TODO: sync checks to frontend
  if (passwdFromForm) {
    if (passwdFromForm.length > MAX_PASSWD_LEN) {
      throw new WorkerError(400, `password too long (${passwdFromForm.length} > ${MAX_PASSWD_LEN})`)
    } else if (passwdFromForm.length < MIN_PASSWD_LEN) {
      throw new WorkerError(400, `password too short (${passwdFromForm.length} < ${MIN_PASSWD_LEN})`)
    } else if (passwdFromForm.includes("\n")) {
      throw new WorkerError(400, `password should not contain newline`)
    }
  }

  // check if name is legal
  if (nameFromForm !== undefined && isPut) {
    throw new WorkerError(400, `Cannot set name for a PUT request`)
  }
  if (nameFromForm !== undefined && !NAME_REGEX.test(nameFromForm)) {
    throw new WorkerError(400, `Name ${nameFromForm} not satisfying regexp ${NAME_REGEX}`)
  }

  function makeResponse(created: PasteResponse, additionalHeaders: Record<string, string | undefined> = {}): Response {
    return new Response(JSON.stringify(created, null, 2), {
      headers: { "Content-Type": "application/json;charset=UTF-8", ...additionalHeaders },
    })
  }

  // 使用请求的 origin 作为基础 URL，这样可以在 Cloudflare 后台修改后立即生效
  const baseUrl = env.DEPLOY_URL || url.origin

  function accessUrl(short: string): string {
    return baseUrl + "/" + short
  }

  function manageUrl(short: string, passwd: string): string {
    return baseUrl + "/" + short + PASSWD_SEP + passwd
  }

  const now = new Date()
  if (isPut) {
    let pasteName: string | undefined
    let password: string | undefined
    // if isMPCComplete, we cannot parse path
    if (!isMPUComplete) {
      const parsed = parsePath(url.pathname)
      // password can be empty string (for no-password paste), but must be present in URL (with colon)
      if (parsed.password === undefined) {
        throw new WorkerError(403, `no password separator for PUT request (use /name: for no-password paste)`)
      }
      pasteName = parsed.name
      password = parsed.password
    } else {
      pasteName = url.searchParams.get("name") || undefined
      if (pasteName === undefined) {
        throw new WorkerError(400, `no name for MPU complete`)
      }
    }

    const r2Object = isMPUComplete ? await handleMPUComplete(request, env, uploadedParts!) : undefined

    const originalMetadata = await getPasteMetadata(env, pasteName)
    if (originalMetadata === null) {
      throw new WorkerError(404, `paste of name ‘${pasteName}’ is not found`)
    }

    // no need to check password for MPCComplete, it is already checked on creation
    if (!isMPUComplete && password !== originalMetadata.passwd) {
      throw new WorkerError(403, `incorrect password for paste ‘${pasteName}’`)
    }

    const newPasswd = passwdFromForm || originalMetadata.passwd
    await updatePaste(env, pasteName, content, originalMetadata, {
      expirationSeconds,
      now,
      passwd: newPasswd,
      contentLength: r2Object?.size || contentLength,
      filename,
      highlightLanguage,
      encryptionScheme,
      isMPUComplete,
    })
    const isPermanent = expirationSeconds >= PERMANENT_EXPIRATION
    return makeResponse(
      {
        url: accessUrl(pasteName),
        manageUrl: manageUrl(pasteName, newPasswd),
        expirationSeconds: isPermanent ? 0 : expirationSeconds,
        expireAt: isPermanent ? "never" : new Date(now.getTime() + 1000 * expirationSeconds).toISOString(),
        isPermanent,
      },
      { etag: r2Object?.httpEtag },
    )
  } else {
    let pasteName: string | undefined
    if (isMPUComplete) {
      if (url.searchParams.has("name")) {
        pasteName = url.searchParams.get("name")!
      } else {
        throw new WorkerError(400, `no name for MPU complete`)
      }
    } else if (nameFromForm !== undefined) {
      pasteName = nameFromForm
      if (!(await pasteNameAvailable(env, pasteName))) {
        throw new WorkerError(409, `name '${pasteName}' is already used`)
      }
    } else {
      pasteName = genRandStr(isPrivate ? PRIVATE_PASTE_NAME_LEN : PASTE_NAME_LEN)
    }

    const r2Object = isMPUComplete ? await handleMPUComplete(request, env, uploadedParts!) : undefined

    // If password is provided, use it; otherwise use empty string (no password)
    const password = passwdFromForm || ""
    await createPaste(env, pasteName, content, {
      expirationSeconds,
      now,
      passwd: password,
      filename,
      highlightLanguage,
      contentLength: r2Object?.size || contentLength,
      encryptionScheme,
      isMPUComplete,
    })

    const isPermanent = expirationSeconds >= PERMANENT_EXPIRATION
    return makeResponse(
      {
        url: accessUrl(pasteName),
        manageUrl: manageUrl(pasteName, password),
        expirationSeconds: isPermanent ? 0 : expirationSeconds,
        expireAt: isPermanent ? "never" : new Date(now.getTime() + 1000 * expirationSeconds).toISOString(),
        isPermanent,
      },
      { etag: r2Object?.httpEtag },
    )
  }
}
