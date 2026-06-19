# 批量生图大师

这是一个基于 `React + Vite + TypeScript` 的批量生图工具，目前同时支持 `云雾API`、`APIMart` 和 `Muzhi`。

- 云雾默认图像模型：`gemini-3.1-flash-image-preview`
- 云雾默认文本模型：`gemini-3-pro-preview`
- APIMart 默认图像模型：`gpt-image-2`
- APIMart 默认文本模型：`gemini-2.5-pro`
- Muzhi 默认图像模型：`gpt-image-2`
- Muzhi 默认文本模型：`gemini-2.5-pro`
- 页面内可直接切换服务商、填写并保存各自 API Key
- 生图模型暂时固定：云雾用香蕉模型，APIMart 和 Muzhi 用 GPT-2 模型

## 本地运行

1. 安装依赖

```bash
npm install
```

2. 启动开发环境

```bash
npm run dev
```

3. 打开浏览器访问终端里显示的本地地址，通常是 `http://localhost:3000`

4. 在页面里切换到你要使用的服务商，然后填写并保存对应 API Key

## 可选环境变量

- `VITE_YUNWU_API_KEY`: 云雾 API Key
- `VITE_YUNWU_BASE_URL`: 云雾接口基础地址，默认 `https://yunwu.ai`
- `VITE_YUNWU_IMAGE_MODEL`: 云雾默认图像模型，默认 `gemini-3.1-flash-image-preview`
- `VITE_YUNWU_TEXT_MODEL`: 云雾默认文本模型，默认 `gemini-3-pro-preview`
- `VITE_YUNWU_ENABLE_PROMPT_REWRITE`: 云雾是否启用提示词增强，默认 `true`
- `VITE_YUNWU_MIN_REQUEST_INTERVAL_MS`: 每次云雾请求之间的最小间隔，默认 `15000`
- `VITE_YUNWU_MAX_RATE_LIMIT_RETRIES`: 云雾命中 429 后的最大重试次数，默认 `6`
- `VITE_YUNWU_RATE_LIMIT_COOLDOWN_MS`: 云雾命中 429 后的全局冷却时长，默认 `60000`
- `VITE_APIMART_API_KEY`: APIMart API Key
- `VITE_APIMART_BASE_URL`: APIMart 接口基础地址，默认 `https://api.apimart.ai`
- `VITE_APIMART_IMAGE_MODEL`: APIMart 默认图像模型，默认 `gpt-image-2`
- `VITE_APIMART_TEXT_MODEL`: APIMart 默认文本模型，默认 `gemini-2.5-pro`
- `VITE_APIMART_ENABLE_PROMPT_REWRITE`: APIMart 是否启用提示词增强，默认 `true`
- `VITE_APIMART_MIN_REQUEST_INTERVAL_MS`: 每次 APIMart 请求之间的最小间隔，默认 `5000`
- `VITE_APIMART_MAX_RATE_LIMIT_RETRIES`: APIMart 命中 429 后的最大重试次数，默认 `4`
- `VITE_APIMART_RATE_LIMIT_COOLDOWN_MS`: APIMart 命中 429 后的全局冷却时长，默认 `30000`
- `VITE_APIMART_TASK_POLL_INTERVAL_MS`: APIMart 生图任务轮询间隔，默认 `2500`
- `VITE_APIMART_TASK_POLL_TIMEOUT_MS`: APIMart 生图任务轮询超时时间，默认 `120000`
- `VITE_MUZHI_API_KEY`: Muzhi API Key
- `VITE_MUZHI_BASE_URL`: Muzhi 接口基础地址，默认 `https://api.muzhi.ai`
- `VITE_MUZHI_IMAGE_MODEL`: Muzhi 默认图像模型，默认 `gpt-image-2`
- `VITE_MUZHI_TEXT_MODEL`: Muzhi 默认文本模型，默认 `gemini-2.5-pro`
- `VITE_MUZHI_ENABLE_PROMPT_REWRITE`: Muzhi 是否启用提示词增强，默认 `false`
- `VITE_MUZHI_MIN_REQUEST_INTERVAL_MS`: 每次 Muzhi 请求之间的最小间隔，默认 `5000`
- `VITE_MUZHI_MAX_RATE_LIMIT_RETRIES`: Muzhi 命中 429 后的最大重试次数，默认 `4`
- `VITE_MUZHI_RATE_LIMIT_COOLDOWN_MS`: Muzhi 命中 429 后的全局冷却时长，默认 `30000`
- `VITE_MUZHI_TASK_POLL_INTERVAL_MS`: Muzhi 生图任务轮询间隔，默认 `2500`
- `VITE_MUZHI_TASK_POLL_TIMEOUT_MS`: Muzhi 生图任务轮询超时时间，默认 `120000`

## 生成可分发发布包

```bash
npm run package:web
```

执行后会生成 `release-web/`，可直接压缩后发给别人。

- Windows 用户只需安装 Node.js，然后双击 `start-windows.bat`
- Mac 用户可双击 `start-mac.command`

## 说明

- 页面内保存的 Key 会按服务商分别存储，并优先于 `.env.local` 中的 Key 生效。
- 如果云雾报“模型无可用渠道”，通常是账号没有为该模型开通通道，不是前端代码错误。
- APIMart 和 Muzhi 图像模型默认使用 `gpt-image-2`。
- Muzhi 默认关闭提示词增强，默认情况下只调用 `gpt-image-2` 出图。
- 当前版本已经内置请求排队、最小请求间隔和 429 自动退避重试，适合云雾、APIMart 和 Muzhi 这类限流渠道。
