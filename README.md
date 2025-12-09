# Pastebin-worker

This is a pastebin that can be deployed on Cloudflare workers. Try it on [shz.al](https://shz.al).

**Philosophy**: effortless deployment, friendly CLI usage, rich functionality.

**Features**:

1. Share your paste with as short as 4 characters, or even customized URL.
1. **Syntax highlighting** powered by highlight.js.
1. Client-side encryption
1. Render **markdown** file as HTML
1. URL shortener
1. Customize returned `Content-Type`

## Usage

1. You can post, update, delete your paste directly on the website (such as [shz.al](https://shz.al)).

2. It also provides a convenient HTTP API to use. See [API reference](doc/api.md) for details. You can easily call API via command line (using `curl` or similar tools).

3. [pb](/scripts) is a bash script to make it easier to use on command line.

## Limitations

1. If deployed on Cloudflare Worker free-tier plan, the service allows at most 100,000 reads and 1000 writes, 1000 deletes per day.

## Deploy

You are free to deploy the pastebin on your own domain if you host your domain on Cloudflare.

### Option 1: GitHub Actions 自动部署 (推荐)

使用 GitHub Actions 可以自动配置 KV 命名空间和 R2 存储桶，无需手动在 Cloudflare 后台操作。

#### 步骤 1: Fork 仓库

Fork 本仓库到你的 GitHub 账户。

#### 步骤 2: 创建 Cloudflare API Token

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击右上角头像 → **My Profile** → **API Tokens**
3. 点击 **Create Token**
4. 选择 **Create Custom Token**，配置以下权限：
   - **Account** > **Workers KV Storage** > **Edit**
   - **Account** > **Workers R2 Storage** > **Edit** (如果需要大文件支持)
   - **Account** > **Workers Scripts** > **Edit**
   - **Zone** > **Workers Routes** > **Edit**
5. 复制生成的 Token

#### 步骤 3: 获取 Account ID

1. 在 Cloudflare Dashboard 首页，点击任意域名
2. 在右侧边栏找到 **Account ID**，复制它

#### 步骤 4: 配置 GitHub Secrets

在你 Fork 的仓库中：

1. 进入 **Settings** → **Secrets and variables** → **Actions**
2. 点击 **New repository secret**，添加以下 Secrets：

| Secret 名称 | 说明 |
|------------|------|
| `CF_API_TOKEN` | Cloudflare API Token (步骤 2 创建的) |
| `CF_ACCOUNT_ID` | Cloudflare Account ID (步骤 3 获取的) |

#### 步骤 5: 触发部署

进入 GitHub 仓库页面 → **Actions** → **Test and Deploy** → **Run workflow**

可选参数：

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `r2_bucket_name` | R2 存储桶名称 | `pb-storage` |
| `skip_r2` | 跳过 R2 配置 | `false` |

部署成功后，访问地址会显示在 Actions 的 Summary 中。

#### 可选: 使用自定义域名

如果你想使用自己的域名而不是 workers.dev，编辑 `wrangler.toml`：

```toml
workers_dev = false

[[routes]]
pattern = "paste.your-domain.com"
custom_domain = true
```

#### 自动配置说明

部署工作流会自动：
1. ✅ 检查并创建 KV 命名空间
2. ✅ 检查并创建 R2 存储桶 (如果可用)
3. ✅ 更新 `wrangler.toml` 中的绑定配置
4. ✅ 部署 Worker

如果 R2 不可用（账户未启用或权限不足），会自动禁用 R2 功能，大文件上传将受到 `R2_THRESHOLD` 限制（默认 5MB）。

---

### Option 2: 手动部署

如果你更喜欢手动控制部署过程：

1. Install `node` and `yarn`.

2. Create a KV namespace on Cloudflare workers dashboard, remember its ID. Optionally, create an R2 bucket if you want to support large file uploads (files larger than 5MB by default).

3. Clone the repository and enter the directory.

4. Modify entries in `wrangler.toml`. Its comments will tell you how. Note: R2 bucket is optional - without it, file uploads are limited to the `R2_THRESHOLD` size (default 5MB).

5. Login to Cloudflare and deploy with the following steps:

```console
$ yarn install
$ yarn wrangler login
$ yarn build:frontend
$ yarn deploy
```

6. Enjoy!

## Auth

If you want a private deployment (only you can upload paste, but everyone can read the paste), add the following entry to your `wrangler.toml`.

```toml
[vars.BASIC_AUTH]
user1 = "$2b$08$i/yH1TSIGWUNQVsxPrcVUeR0hsGioFNf3.OeHdYzxwjzLH/hzoY.i"
user2 = "$2b$08$KeVnmXoMuRjNHKQjDHppEeXAf5lTLv9HMJCTlKW5uvRcEG5LOdBpO"
```

Passwords here are hashed by bcrypt2 algorithm. You can generate the hashed password by running `./scripts/bcrypt.js`.

Now every access to POST request, and every access to static pages, requires an HTTP basic auth with the user-password pair listed above. For example:

```console
$ curl example-pb.com
HTTP basic auth is required

$ curl -Fc=@/path/to/file example-pb.com
HTTP basic auth is required

$ curl -u admin1:wrong-passwd -Fc=@/path/to/file example-pb.com
Error 401: incorrect passwd for basic auth

$ curl -u admin1:this-is-passwd-1 -Fc=@/path/to/file example-pb.com
{
  "url": "https://example-pb.com/YCDX",
  "admin": "https://example-pb.com/YCDX:Sij23HwbMjeZwKznY3K5trG8",
  "isPrivate": false
}
```

## Administration

Delete a paste:

```console
$ yarn delete-paste <name-of-paste>
```

List pastes:

```console
$ yarn -s wrangler kv key list --binding PB > kv_list.json
```

## Development

Note that the frontend and worker code are built separatedly. To start a Vite development server of the frontend,

```console
$ yarn dev:frontend
```

To develop the backend worker, we must build a develop version of frontend,

```console
$ yarn build:frontend:dev
```

Then starts a local worker,

```console
$ yarn dev
```

The difference between `build:frontend:dev` and `build:frontend` is that the former will points the API endpoint to your deployment URL, while the later points to `http://localhost:8787`, the address of a local worker.

Run tests:

```console
$ yarn test
```

Run tests with coverage report:

```console
$ yarn coverage
```

Remember to run eslint checks and prettier before commiting your code.

```console
$ yarn fmt
$ yarn lint
```
