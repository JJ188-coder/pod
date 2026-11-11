---
name: magpie-image
description: 统一生图入口，默认走image2网关（ChatGPT Pro/gpt-image-2）出图和参考图改图；image2不可用时回退本机Magpie。单图用image2_generate，批量商品图仍用batch-images.mjs后台并发。复用防重账本、每任务隔离原图、最终按款平铺；多品类8商品图+1真实尺码图，每色生成主图匹配SKU。
---

# 生图工作室（image2 优先）

> 下文所有「提示词规则」（锁图案、锁机型、外表面装机、镜头凸台、双参考图锁人物、人物池轮换）**与通道无关**：换 image2、Magpie 还是别的网关，规则本身照用，只是参数名不同——image2 用 `images`，Magpie 用 `reference_images`，Grsai 用 `images` 且接受 base64。跨插件的完整流程以项目内《手机壳上架标准流程.md》为准。

模型调用交给本机Magpie（默认`http://127.0.0.1:3425/mcp/magpie/image`），本插件组织请求、只提交一次并保存结果，不擅改模型设置。

## 先选通道：image2 优先

- **默认走 image2**：`image2_generate`（出图/改图）、`image2_check`（连通性）。网关`https://image2.bri-king.com`，模型`codex/gpt-image-2`，密钥在`~/.config/image2-studio/config.json`（0600），不打印、不写进脚本。
- `image2_generate`参数：`prompts[]`每条出一张（最多8条），`images`参考图（本机绝对路径/URL/data URL，整批共用，单条可覆盖），`size`取`1024x1024`/`1536x1024`/`1024x1536`/`auto`，`quality`取`low`/`medium`/`high`/`auto`，`concurrency`1–20，`output_dir`默认`~/Pictures/image2-studio`。有参考图时自动走`/v1/images/edits`，无参考图走`/v1/images/generations`。
- **size 只是请求值，实测不生效**（2026-11-10）：文生图要 `1024x1024` 实际给 `1536x1024`；改图跟随参考图尺寸（`1086x1448` 进 → `1086x1448` 出）。结果里带 `width`/`height`，不符时给 `size_warning`；交付和上架必须以实际尺寸为准，或按参考图比例控制、必要时后裁切。
- **Magpie 只作备用**：image2 返回 5xx、Cloudflare 1033（隧道源站未连通）、或用户明确要求本机出图时，才切回`image_generate`/`image_result`。
- 通道只在提交前决定；已提交的任务不跨通道重发，失败重生成按用户授权判断，不借换通道绕开额度。
- 插件 MCP 尚未加载（改了插件但没重启 ZCode）时，可直接用同一脚本：`python3 <plugin-root>/scripts/image2_mcp.py check`、`... generate --spec <batch.json>`，参数与工具一致。

## 先分单图与整批

- 商品素材先加载`pod-pipeline`及其`references/product-media-standard.md`。每款8展示图＋1本地真实尺码/规格图＋模型原声9:16视频＋>500字符西语说明；每色主图与SKU精确匹配。不是所有图都由生图模型画，也不把工厂图直接交给SKU。
- 第一次真实生图或环境异常时调用`image_check`，只读工具列表；仅维护技能/离线测试不调用真实服务。
- 单图：组织提示词→`image_generate`一次→pending用`image_result`续查→交付实际文件。
- 多图/多商品：使用下面批次CLI，整批先预检、一次后台运行。不要用单图工具“第一张完成再下一张”，也不为实现并发擅建动态Workflow。
- 仅讨论方案或固化规则不生成。用户明确要求该批素材时按已授权数量执行；额外颜色图、新版本、失败重生成超出数量范围先说明并确认，不无限追加费用。

## 批次CLI（已实现，不是新MCP工具）

脚本为本技能所在插件根的`scripts/batch-images.mjs`。**默认`--provider image2`**：整批交给 image2，同步生成、按输出文件续跑、清单与参考图哈希绑定；`--provider magpie`才走原有`generateImageTask/refreshImageTask`与SQLite账本。把`<plugin-root>`替换为本次实际加载的插件根，不猜安装版本。

image2 批次要点：清单格式不变（`jobs[]`每项`request_id`/`prompt`/`reference_images`/`output_file`，`local_files[]`归档尺码图）；`size`可用比例自动映射（1:1→1024x1024，3:4/2:3/9:16→1024x1536，4:3/3:2/16:9→1536x1024），但如上，实际尺寸仍由参考图/模型决定；参考图必须是已存在的绝对路径普通文件；并发默认 20、上限 20；同一批次重复执行按已存在输出跳过，不重复生成；清单内容或参考图变化会因批次记录哈希不符被拒绝。实测单张改图约 44–96 秒。

由代理写一次完整清单，不让用户手填JSON：

```json
{
  "batch_id": "media-20261107-batch-r01",
  "jobs": [
    {
      "request_id": "media-20261107-stylea-blanco-front-r01",
      "prompt": "本款白色商品正面展示，保持参考图真实款式、颜色、结构和图案……",
      "reference_images": ["/absolute/factory/stylea-white.jpg"],
      "size": "3:4",
      "output_file": "/absolute/stylea/生成图/01-Blanco-正面.png"
    }
  ],
  "local_files": [
    {
      "source": "/absolute/work/stylea-sizechart.png",
      "output_file": "/absolute/stylea/生成图/09-尺码表.png"
    }
  ]
}
```

- `jobs`列齐整批AI图片，每项一张（`n=1`），每个request_id和目标文件唯一，使用绝对路径。不得借`n=4`冒充4个独立场景。
- `local_files`是已按真实资料排好的尺码图，脚本只复制并校验，不负责自动造尺码或排版。可为空；仅local_files也可，不调用模型。
- 10款默认是80个AI任务＋10张本地尺码图＝90张交付图；多色需补图时明确总数。用同一个批次收齐，不能说向上游发送了不存在的90条AI请求。
- batch_id和request_id使用稳定的批次/款/颜色/镜头/版本标识：1–200位ASCII字母数字、点、横线、下划线，字母数字开头，不含`..`、斜杠或空格。恢复保留原清单与ID；任务内容或本地参考/尺码文件的SHA变化会报冲突，不靠换ID自动重发。批次参考图仅接受已下载的本地普通文件绝对路径，不直接用远端URL。

```bash
# 纯只读预检：不建目录、不调用生成服务（两个通道都支持）
node <plugin-root>/scripts/batch-images.mjs --manifest /absolute/media-batch.json

# 已授权整批真实生成（默认 image2）：一次后台Bash（run_in_background:true，不加&）
node <plugin-root>/scripts/batch-images.mjs --manifest /absolute/media-batch.json --run

# 需要旧 SQLite 账本/验证码流程时才切回 Magpie
node <plugin-root>/scripts/batch-images.mjs --manifest /absolute/media-batch.json --run --provider magpie
```

并发：image2 通道默认 20、上限 20；Magpie 通道沿用原有提交/查询两阶段。不是一个HTTP请求装90张，也不保证供应商90张同时渲染。上游有明确容量限制时显式用`--concurrency N`，说明限制，不谎称全量同时渲染。`--max-wait-min`默认60、`--poll-seconds`默认20（仅 Magpie 通道需要）。后台自己等待，主会话不sleep/循环调用MCP查询。

每批仅一个执行器。后台退出前不再启动相同批次；收到通知后读逐项总结，记录在账本目录的`batches/<batch_id>/latest-report.json`。默认预检只检查参数和静态文件，`--run`会先整批核对已有request_id与目标冲突，通过后才提交。未完成用同一清单/同一命令恢复，保留已提交任务；未知提交状态不能靠新ID重试。遇401/403/429、权限/额度不绕过，停止未派发项和自动查询；已派发请求无法撤回。只有最终文件`saved/reused`才算完成，生成完成但下载失败、原图丢失、复制冲突均另报。

脚本每任务隔离原始下载，按`output_file`平铺到各商品目录；不同内容已有目标报冲突，不覆盖。返回格式与扩展不符时报错，不把JPEG字节改名为PNG。需要等比适配/格式转换时保留母版，处理后重新登记SHA和验收。


### 并发参数（2026-11-10 实测补充）

- **禁止串行**：不要「提交一张 → 等它出图 → 再提交下一张」。这是把等待写进循环，200 张会拖到 2 小时，纯属浪费。
- 默认整批 20 路并发提交，不用再加 `--concurrency` 降速。历史参照：270 张 8–10 路约 20–30 分钟，同等量级串行要 2–2.5 小时。
- 单张生成本身要 20–40 秒，这是模型耗时，不是排队问题；并发只能把总时间压到「张数 ÷ 并发数 × 单张耗时」。
- **20 路上限按要求直接生效（2026-11-10），未做真实压测**；image2 网关若返回 429/超时/NOID，说明撞到上游限流，降到 10 路再跑。
- 失败率超过 20% 先降并发，不在失败后继续加并发；不要在同一路数上反复重发。
- 断点续跑：同一批清单重新执行会跳过已存在的 `output_file`，只补缺的，不用重建任务。


## 手机壳结构保真（2026-11-10 修正）

工厂实拍确认：手机壳的镜头模组是**明显高出背板的一整块凸起平台**，平台边缘有阶梯落差和阴影，印刷面比它低一档。AI 常把镜头区画成与背板齐平的平板，孔像贴在平面上，视觉上就成了"凹进去"，与实物不符。

写手机壳提示词时固定加入：

- `the camera module is a raised platform standing clearly above the back panel, with a visible step-down edge and a soft shadow along that edge`
- `the printed back panel sits lower than the camera platform`
- 负向：`do not make the camera area flush with the back panel, do not render the camera holes as flat stickers`

生成后验收：从背面看，镜头平台必须比背板高出一档，斜面或阶梯处能看到明暗变化。齐平的判不合格，重做。

## 手机壳正反面（2026-11-10 二次修正，优先级高于上一条）

真实手机壳是**从外侧打印**的：图案在壳的外表面，从外面看是正的。AI 画「空壳」时没有正反参照，默认画成内腔——镜头孔成了内凹的井，图案像贴在内衬上，实物不存在这个视角。整批空壳图因此全部报废。

规则：

- **禁止单独画空壳**。所有静物场景一律画装机状态：手机已装进壳里，背面朝镜头。
- 提示词固定写：`a phone is installed inside the case; we are looking at the OUTER back surface; the printed design is on the exterior and reads correctly left to right`
- 负向：`no empty shell, do not show the inner cavity or inner lining, do not show the case from inside, no concave camera well`
- 镜头平台仍按上一条做外凸处理，凸起方向朝观者。
- 白底正面图同样装机，或至少让外表面正对镜头、内腔完全不可见。

## 手机壳颜色图从单张厂家图改色（2026-11-12，替代“按顺序套厂家图”）

厂家货盘一个材质通常只给 4–8 张**材质示例图**（多为带示例印花的生活图），不是按颜色拍的。把这几张按排序当作颜色图是错的：图里既不是该颜色，也不是本店商品。

正确做法：

- 每个材质挑**一张最干净、外表面正对镜头、无印花或印花最少**的厂家实拍，作为该材质唯一的商品结构参考。
- 该材质在售的每个颜色，都用这张参考做**改色生成**：只改壳体颜色，结构、镜头平台、孔位、机型、印刷面视角全部保持。
- 提示词锁死：`keep the exact same case structure, camera module, cutouts and material; change ONLY the shell color to <颜色>`，并附该色的具体色相描述；负向：`do not add any printed artwork or text, do not change the shape`
- 产品按颜色名逐个对应生成图（`sku-01.jpg`、`sku-02.jpg`…顺序 = 货盘颜色列顺序），建表时 SKU 行按色名引用，不按图片文件名猜。
- 验收：逐色对照色名（Negro/Rosa/Azul…），颜色不符或结构被改动的重做；不允许拿第一张顶替其他颜色。

验收：图案必须正读（有方向性的图案如文字、棋盘斜纹、心形轮廓都要能判断），镜头是外凸块而不是内凹井，壳内腔一张都不许出现。不合格重做。

## 印花类商品：图案必须用参考图（2026-11-10 三次修正）

只用文字描述图案会漂移：同一商品的手持图和场景图出现两种底色、两种纹理，甚至和图案原图对不上（文字写 "on soft pink"，原图其实是黄底）。电商九图里这就叫「主图不一致」。

规则：

- 把图案原图作为**参考图**传给模型（`images` 参数），提示词只写「附图为唯一背板图案，保持同一尺度同一颜色，不要改色、不要新增元素」
- **不要再在文字里描述图案颜色**，避免文字和参考图打架
- 机型写死 `iPhone 15 Pro`，边框和镜头板颜色按材质写死，不让模型自由发挥
- 同一商品的所有场景用同一份参考图和同一段材质描述重新生成，不与旧批次混用
- 验收：六张图拼成网格，检查机型、边框色、图案底色三项一致

## 人物图必须轮换（2026-11-10 四次修正）

批量给几十上百个商品配手持图和镜面自拍时，如果所有商品共用同一段人物描述，模型会反复画同一个人：同一张脸、同一件衣服、同一个房间。买家在商品列表里连续翻几个款，看到的都是同一个女生，店铺会显得像模板站。

规则：

- 准备一份**人物变体清单**，覆盖发型、肤色、体型、穿搭、场景五个维度，至少 20 组
- 按商品序号取模分配，同一批内不连续复用；同一材质的不同图案也要换人
- 手持场景和镜面场景各自轮换背景（街边、卧室窗边、咖啡馆、玄关、衣帽间、试衣间），不要固定一个房间
- 姿势也要变：单手举、双手握、贴脸、侧身、低头看
- 提示词里写具体特征（`long wavy chestnut hair, olive skin, slim athletic build, cream knit sweater`），不要只写 "a young woman"
- 验收：随机抽 8–10 个商品的 01/02 图拼一张网格，出现重复面孔或重复穿搭就重跑该批的人像图（场景图不受影响，不用动）

**只换发型和衣服仍然会输出同一张脸。** 实测 147 个商品用「不同发型 + 不同穿搭 + 不同肤色」的 24 组描述重跑，拼图后仍是同一个女生，只有发型变了。

有效做法是把**族裔、年龄、脸型**这三个维度也写死，并且每个商品给一组不同组合：

- `22-year-old Afro-Mexican woman with a round face, full lips and box braids, deep espresso skin`
- `28-year-old mestiza woman with an angular jaw, a straight nose and a slicked-back bun, warm tan skin`
- `31-year-old European-Spanish woman with an oval face and wavy auburn hair, fair warm skin`
- `26-year-old woman with a diamond-shaped face, high cheekbones and short curly hair, deep brown skin`

按 `face = FACES[图案序号]`、`outfit = OUTFITS[(图案序号 + 材质序号) % 7]`、场景列表取模分配，147 个商品就能拿到 147 组不同的人。九张测试图验证：加上族裔和脸型后脸终于分开了。

**但多批次跑下来，纯文字仍会收敛。** 147 个商品用 21 组强差异描述重跑，拼图后仍是同一张脸；换成 9 组已验证能分开的描述循环，结果还是同一个人。文字控人物不可靠。

最终有效方案是**双参考图**：第一张传图案，第二张传人物照片，提示词明确分工。

- `reference_images: [图案2比3竖版, 人物照片]`
- 提示词：`Use the FIRST image as the exact back-panel artwork. Use the SECOND image only for the woman's face, hair and skin tone — she is the model. Replace the case in the photo with a new phone case: <材质描述>, an iPhone 15 Pro fitted inside, we see the OUTER back surface, fully covered by the artwork from the first image at the same scale and colors.`
- 先建一个 30 人的人物池（族裔/年龄/脸型/发型/肤色/穿搭各不同，纯人像、不带手机），按商品序号取模分配
- 实测：三张测试图是三个完全不同的人，图案和机型也都对

人物池的生成提示词：`Portrait photo of a <年龄+族裔+脸型+发型>, <肤色>, slim build, wearing <穿搭>. Head and shoulders, looking at camera with a natural relaxed expression, standing outdoors with soft greenery behind, bright natural daylight, 85mm lens look. Photorealistic, no phone.`

## request_id与状态

`request_id`是本地防重键，不是供应商幂等保证。

- 同一意图恢复原批次和ID；`deduped:true`是已有任务，不能当新生成。批次CLI拒绝挪用其他批次或单图任务的ID，避免同路径参考图变更后错误复用旧图。
- `pending`用已有task_id/remote_id续查；等待响应被旧工具标failed但明确有远端ID时只用`image_result`恢复，不再generate。
- `submission_unknown`或`submitting`无远端ID可能已经计费：不自动重发。用户在Magpie找到ID后通过`image_result`补填；未核清先报告。
- 生成成功但保存失败只重试下载，不重生成；明确failed不自动新建任务。账本仍有认证/额度/限流错误时，重启批次也不会继续派发未提交项；先解决阻塞并人工核对，不能换ID绕过。新一组或改版需新的真实需求和费用范围。
- 同一文件路径内容变化也不是原任务结果已更新；参考图/尺码源变更应新版本规划，不自动绕冲突。

## 提示词与验收

- 写清主体、场景、光线、颜色和画幅；参考图显式传入。普通任务未指定尺寸则省略size，商品包按标准约3:4请求；模型可能忽略size，检查实际像素后等比缩放/补边，不裁掉产品或拉伸。
- 不传用户未选择的model，不声称使用了未核实模型；不擅自改变品牌、图案、颜色、款式。
- 每个在售颜色至少1张该色生成主图。颜色来源锁定本款参考，花灰与纯灰等不能近似合并；生成图与工厂图逐张对照，工厂原图不直接当SKU最终图。
- 尺码文字数字使用本地排版和OCR/视觉核对；不让生图模型编制表格。
- `received/saved`只代表返回/落盘数量；CLI成功不等于视觉验收。描述逐项实际成功、失败、待完成；不编百分比或剩余时间，不保证无重复费用。
- 每款最终目录平铺编号、不按场景拆目录；交付绝对路径Markdown链接，不贴base64或只给临时URL。

## 边界

不自动启动/重启/安装Magpie，不改模型设置，不部署图床或上架商品。单图MCP调用结束后没有自动后台续查；批次CLI由一次后台Bash运行，可持续到退出/宿主停止，但不保证应用退出后继续或自动恢复。技能和文件已更新不等于当前MCP服务已热加载，批次CLI可直接运行新的文件。
