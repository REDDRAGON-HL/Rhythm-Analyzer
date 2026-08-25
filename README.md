# 节奏解析工具

自动解析谱面每个音符的时值与节奏型，在时间轴上可视化呈现

**在线使用:**  https://dragonred.cn/RhythmAnalyzer

### 写在前面
节奏解析工具是很直观非常好用的东西。

但拥有自己的节奏解析工具的人都选择了闭源，加上制作难度高，限制了此类视频产出速度

所以在我为自己的节奏解析视频制作此工具时就决定最终会把本工具公开

## 功能

- **格式**：自动识别谱面格式；BPM 变更、offset 自动处理
- **节奏识别**：标准 / 附点 / 三连 / 五连 / 七连 / 九连音自动识别与染色，非标准间隔显示分数或≈小数
- **就近染色**：每个note取左右邻间隔中较近一方的类型染色，视觉上挨在一起的音同色；形状与时值则严格显示实际情况
- **多押**：自动合并为一个节奏点并处理多轨时值
- **载入**：导入内容，右键点击载入按钮即可取消载入
- **导出**：点导出弹出设置框——背景（常规黑底 MP4 / 透明 MOV PNG / 透明 PNG 序列 zip）、BPM 面板透明（透明背景可选）、输出格式（保持源格式 / MP4 / MKV / MOV / AVI）、帧率（30/60/90/120）、音频采样率；透明 MOV PNG 无损 alpha（剪映/FCPX/PR 原生直接识别）、PNG 序列 zip 导入剪辑软件保留透明；格式转换失败自动回退源格式；需较新浏览器（Chrome / Edge 94+，WebCodecs 支持；透明 MOV 另需 localhost 或 https 安全上下文）。

## 格式支持
已支持的格式
- malody key（.mc）
- osu! mania（.osu）

新增格式文件调用 `registerChartAdapter(name, detect, extract)` 注册，再在 index.html 加一行 `<script>` 即可——BPM 分段、时值识别、染色、多押合并等全部自动复用。接口契约见 `chart-core.js` 头部注释。


## 目录结构

```
index.html        主程序（结构 / 样式 / 交互）
chart-core.js     谱面解析核心：格式注册接口 + 格式无关解析管线
malody-mc.js      Malody 格式支持
osu-mania.js      osu!mania .osu 格式支持
chart-export.js   导出编排：逐帧渲染画布 + 黑底 MP4（WebCodecs worker 调度）/ 透明 MOV PNG（ffmpeg.wasm 单实例）/ PNG 序列 zip + 格式转换
export-worker.js  黑底 MP4 导出 Worker（WebCodecs H.264/AAC 编码 + mp4-muxer 封装；webm VP9 alpha 路径代码保留，待浏览器原生实装后自动恢复）
lib/
  ├ mp4-muxer.min.js    mp4 封装库（本地化 MIT）
  ├ webm-muxer.min.js   webm 封装库（本地化 MIT，代码保留待 VP9 alpha 实装）
  └ ffmpeg/             ffmpeg.wasm v0.12.10 本地化（透明 MOV PNG 导出 + 格式转换引擎）
      ├ index.js / classes.js / worker.js
      └ core/  ffmpeg-core.esm.js + ffmpeg-core.wasm
```

## TODO
- [x] 自定义字体
- [x] 关掉这个很丑的变bpm动画的按钮
- [x] 更棒的导出
- [ ] 多次暂停后音频延迟问题

## 感谢
- [8岁时光](https://space.bilibili.com/12913967) 原版节奏解析作者
- [石原坂奈](https://space.bilibili.com/354869623) 就近染色的理论基础
- 提供了帮助和建议的大家