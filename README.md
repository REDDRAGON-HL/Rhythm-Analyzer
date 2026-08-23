# 节奏解析工具

自动解析谱面每个音符的时值与节奏型，在时间轴上可视化呈现

**在线使用:**  https://dragonred.cn/RhythmAnalyzer

### 写在前面
节奏解析工具是很直观非常好用的东西。

但拥有自己的节奏解析工具的人都选择了闭源，加上制作难度高，限制了此类视频产出速度

所以在我为自己的节奏解析视频制作此工具时就决定最终会把本工具公开

## 功能

- **格式**：自动识别谱面格式；BPM 变速、offset 自动处理
- **节奏识别**：标准 / 附点 / 三连 / 五连 / 七连 / 九连音自动识别与染色，非标准间隔显示分数或 ≈ 小数
- **就近染色**：每个音符取左右邻间隔中较近一方的类型染色，视觉上挨在一起的音同色；形状与时值则严格显示实际情况
- **多押**：同拍音符自动合并为一个节奏点并处理多轨时值
- **载入**：导入内容，右键点击三个载入按钮即可取消载入
- **字体**：导入本地字体文件
- **导出**：离线逐帧渲染 mp4（H.264 + AAC），需较新浏览器（Chrome / Edge 94+，或较新 Firefox，WebCodecs 支持）

## 格式支持
已支持的格式
- malody key（.mc）
- osu! mania（.osu）

新增格式文件调用 `registerChartAdapter(name, detect, extract)` 注册，再在 index.html 加一行 `<script>` 即可——BPM 分段、时值识别、染色、多押合并等全部自动复用。接口契约见 `chart-core.js` 头部注释。


## 目录结构

```
index.html        主程序
chart-core.js     谱面解析核心：格式注册接口 + 格式无关解析管线
malody-mc.js      Malody 格式支持
osu-mania.js      osu!mania .osu 格式支持
export-worker.js  导出编码 Worker
lib/              mp4 封装库
```

## TODO
- [x] 自定义字体
- [x] 关掉这个很丑的变bpm动画的按钮
- [ ] 更棒的导出
- [ ] 多次暂停后音频延迟问题

## 感谢
- [8岁时光](https://space.bilibili.com/12913967) 原版节奏解析作者
- [石原坂奈](https://space.bilibili.com/354869623) 就近染色的理论基础
- 提供了帮助和建议的大家