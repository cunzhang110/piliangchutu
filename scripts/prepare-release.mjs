import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const releaseDir = path.join(projectRoot, "release-web");
const releaseDistDir = path.join(releaseDir, "dist");

if (!fs.existsSync(distDir)) {
  console.error("dist directory not found. Run npm run build first.");
  process.exit(1);
}

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(releaseDir, { recursive: true });
fs.cpSync(distDir, releaseDistDir, { recursive: true });
fs.copyFileSync(path.join(projectRoot, "scripts", "static-server.mjs"), path.join(releaseDir, "server.mjs"));

const windowsLauncher = `@echo off
cd /d "%~dp0"
echo Starting local server...
node server.mjs
pause
`;

const macLauncher = `#!/bin/bash
cd "$(dirname "$0")"
echo "Starting local server..."
node server.mjs
`;

const readme = `批量生图大师 - 发布包

这个目录可以直接发给其他人使用。

使用要求
1. 电脑里安装 Node.js
2. 不需要再执行 npm install

Windows 使用方法
1. 双击 start-windows.bat
2. 浏览器打开 http://localhost:3000

Mac 使用方法
1. 终端进入本目录
2. 运行: chmod +x start-mac.command
3. 双击 start-mac.command 或执行 ./start-mac.command
4. 浏览器打开 http://localhost:3000

首次进入页面后，在界面里填写云雾API Key 并保存即可。
`;

fs.writeFileSync(path.join(releaseDir, "start-windows.bat"), windowsLauncher, "utf8");
fs.writeFileSync(path.join(releaseDir, "start-mac.command"), macLauncher, "utf8");
fs.writeFileSync(path.join(releaseDir, "README.txt"), readme, "utf8");
fs.chmodSync(path.join(releaseDir, "start-mac.command"), 0o755);

console.log(`Release package prepared at: ${releaseDir}`);
