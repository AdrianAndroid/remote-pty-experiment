# 打包后的 .app 打不开：Dock 图标把启动流程打断

## 为什么

`pnpm build && electron-builder --mac dir` 装到 `/Applications` 后双击，进程起来了但**一个窗口都没有**，只有几秒后自己留在 Dock 里假装活着。

日志只有一句：

```
UnhandledPromiseRejectionWarning: Error: Failed to load image from path
'/Applications/rpty.app/Contents/Resources/app.asar/build/icon.png'
    at .../out/main/index.js:1824:76
```

根因在 `app.whenReady().then(...)` 的第一行：

```ts
app.dock.setIcon(join(__dirname, '../../build/icon.png'))
```

`build/` 不在打包清单里（`files` 只有 `out/**/*` 与 `package.json`），路径在 asar 里根本不存在，Electron 直接抛错。而这行在 `whenReady` 的回调里、排在 `createWindow()` 之前——一抛，后面的 `registerIpc/buildMenu/createWindow` 全都没跑。

开发版能用，是因为 `__dirname` 指向仓库里的 `out/main`，`../../build/icon.png` 真的存在。

## 怎么做

- 打包后不再手工设 Dock 图标：`.app` 用的是 `build/icon.icns`，已经由 electron-builder 写进 Bundle。
- 开发时保留这一步，但加 `existsSync` 与 try/catch——图标是装饰，不该有权力把整个启动流程带走。

## 效果

- 装好的 `/Applications/rpty.app` 双击即出窗口，日志干净。
- 以后任何「资源没打进包」的同类问题最多丢掉一个图标，不会变成打不开。
