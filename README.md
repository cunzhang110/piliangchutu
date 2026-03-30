# 批量生图大师

这是一个基于 `React + Vite + TypeScript` 的批量生图工具，目前仅保留 `云雾API` 接入。

- 图像模型默认使用 `gemini-3.1-flash-image-preview`
- 文本模型默认使用 `gemini-3-pro-preview`
- 页面内可直接填写并保存云雾 API Key
- 页面内可直接修改图像模型和文本模型

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

4. 在页面里填写并保存云雾 API Key

## 可选环境变量

- `VITE_YUNWU_API_KEY`: 云雾 API Key
- `VITE_YUNWU_BASE_URL`: 云雾接口基础地址，默认 `https://yunwu.ai`
- `VITE_YUNWU_IMAGE_MODEL`: 默认图像模型，默认 `gemini-3.1-flash-image-preview`
- `VITE_YUNWU_TEXT_MODEL`: 默认文本模型，默认 `gemini-3-pro-preview`
- `VITE_YUNWU_ENABLE_PROMPT_REWRITE`: 是否启用提示词增强，默认 `true`
- `VITE_YUNWU_MIN_REQUEST_INTERVAL_MS`: 每次云雾请求之间的最小间隔，默认 `15000`
- `VITE_YUNWU_MAX_RATE_LIMIT_RETRIES`: 命中 429 后的最大重试次数，默认 `6`
- `VITE_YUNWU_RATE_LIMIT_COOLDOWN_MS`: 命中 429 后的全局冷却时长，默认 `60000`

## 生成可分发发布包

```bash
npm run package:web
```

执行后会生成 `release-web/`，可直接压缩后发给别人。

- Windows 用户只需安装 Node.js，然后双击 `start-windows.bat`
- Mac 用户可双击 `start-mac.command`

## 说明

- 页面内保存的云雾 Key 会优先于 `.env.local` 中的 Key 生效。
- 如果报“模型无可用渠道”，通常是云雾账号没有为该模型开通通道，不是前端代码错误。
- 当前版本已经内置请求排队、最小请求间隔和 429 自动退避重试，适合云雾这类限流较严格的渠道。
