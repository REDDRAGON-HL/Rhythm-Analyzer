# 节奏解析工具

自动解析谱面每个音符的时值与节奏型，在时间轴上可视化呈现

**在线使用:**  https://dragonred.cn/RhythmAnalyzer

### 写在前面
节奏解析工具是很直观非常好用的东西。

但拥有自己的节奏解析工具的人都选择了闭源，加上制作难度高，限制了此类视频产出速度

所以在我为自己的节奏解析视频制作此工具时就决定最终会把本工具公开

## 功能

- **格式**：自动识别已支持的谱面格式；BPM 变更、offset 自动处理
- **节奏识别**：标准 / 附点 / 三连 / 五连 / 七连 / 九连音自动识别与染色，非标准间隔显示分数或≈小数
- **就近染色**：每个note取左右邻间隔中较近一方的类型染色，视觉上挨在一起的音同色；形状与时值则严格显示实际情况
- **多押**：自动合并为一个节奏点并处理多轨时值
- **载入**：导入内容，右键点击载入按钮即可取消载入
- **drag**：drag可以不参与节奏点合并、拍时值识别、段结构与渲染

## 导出
导出会使用当前设定的倍速、drag开关、多押开关、bpm切换动效开关、音乐音量；还有如下可选设置
- 编码选项（透明底可额外选择bpm面板也透明）：
  
| 选项     | 视频编码/像素格式                       | 音频编码    | 输出容器          | 技术依赖 / 备注        |
| -------- | --------------------------------------- | ----------- | ----------------- | ---------------------- |
| 黑底     | H.264 (AVC)                             | AAC         | mp4（muxer 封装） | 需浏览器支持 WebCodecs |
| 透明     | PNG codec + `-pix_fmt rgba -pred mixed` | AAC         | MOV / QuickTime   | 需浏览器支持 WASM      |
| PNG 序列 | 逐帧导出透明底序列（PNG）               | —（无音频） | 文件夹 / 序列帧   | 每帧独立 PNG 文件      |

- 帧率：可选30帧、60帧、90帧、120帧

- 音频采样率：可选44100和48000

- 输出格式：

| 输出格式 | 视频编码    | 音频编码 | 是否保留 Alpha 通道 |
| -------- | ----------- | -------- | ------------------- |
| mp4      | H.264       | AAC      | 否                  |
| mkv      | H.264       | AAC      | 否                  |
| mov      | H.264 / PNG | AAC      | 是                  |
| avi      | MPEG4 / PNG | MP3      | 是                  |

## 格式支持
已支持的格式
- malody key（.mc）
- osu! mania（.osu）（可能有bug）
- Phigros RPE格式（.json）
- Phigros 官谱格式（.json）（对变bpm的处理尚不完善）

新增格式文件调用 `registerChartAdapter(name, detect, extract)` 注册，再在 index.html 加一行 `<script>` 即可——BPM 分段、时值识别、染色、多押合并、drag 开关等全部自动复用。接口契约见 `chart-core.js` 头部注释。


## 目录结构

```
index.html        主程序（结构 / 样式 / 交互）
chart-core.js     谱面解析核心：格式注册接口 + 格式无关解析管线
malody-mc.js      Malody 格式支持
osu-mania.js      osu!mania .osu 格式支持
phi-rpe.js        Phigros RPE格式支持
phi-official.js   Phigros 官谱格式支持
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
- [x] 显示 drag 开关
- [x] Phigros适配器
- [ ] 多次暂停后音频延迟问题
- [ ] phi变速识别问题修复

## 感谢
- [8岁时光](https://space.bilibili.com/12913967) 原版节奏解析作者
- [石原坂奈](https://space.bilibili.com/354869623) 就近染色的理论基础
- 提供了帮助和建议的大家