# 银河（RIIN）OpenAPI 接口手册

> 来源：`RIIN-OpenAPI · 中文版.pdf`（59 页，语雀导出，2026-10）。本文由逐页读图整理，字段名以文档渲染为准；
> 标 ⚠️ 的是文档渲染不清、需要实网确认的项。

## 1. 基本约定

| 项 | 值 |
| --- | --- |
| 生产环境 | `https://tshirt.riin.com` |
| 协议 | HTTPS POST，`Content-Type: application/json` |
| 鉴权 | 请求头带 `secretKey`（密钥）与 `sign`（验签） |
| 签名 | `sign = md5(请求报文字符串 + ":" + secretKey)`，32 位小写十六进制 |
| 密钥来源 | 银河后台 → 店铺管理 → **自建站** 店铺 → 店铺账号 / 密钥（密钥即 secretKey） |
| 返回包 | `{ successful, message, errorCode, data, traceId }` |

签名要点：

- 签名对象是**实际发出去的那一串 JSON 文本**，不是对象。客户端必须先 `JSON.stringify` 一次，再用这串文本算 md5、并原样作为 body 发送。
- 改一个空格就会验签失败，所以不要「算完再美化输出」。
- `data` 为 `null` 时表示成功且无返回体；`successful=false` 时看 `message`（业务原因）与 `traceId`（排查用）。

## 2. 接口总表（23 个）

| # | 接口 | 路径 | 作用 |
| --- | --- | --- | --- |
| 一 | 下单 | `/trade/api/interface/placeOrder` | 建单（自建站/跨境） |
| 二 | 修改订单或商品信息 | `/trade/api/interface/updateOrder` | 改收货信息、平台状态、增商品 |
| 三 | 预发货 | `/trade/api/interface/preShipped` | 标记待发货 |
| 四 | 获取快递面单信息 | `/trade/api/interface/queryOrderDelivery` | 拿运单号与面单文件 |
| 五 | 查询订单状态 | `/trade/api/interface/queryOrderStatus` | 主单 + 子单状态 |
| 六 | 查询产品信息 | `/trade/api/interface/queryProduct` | 产品（cm/kg、in/lbs） |
| 七 | 查询款号信息 | `/trade/api/interface/queryStyle` | 款号 + 工艺 |
| 八 | 查询颜色信息 | `/trade/api/interface/queryColor` | 颜色码表 |
| 九 | 查询尺码信息 | `/trade/api/interface/querySize` | 尺码码表 |
| 十 | 查询工厂发货地址 | `/trade/api/interface/queryShipAddress` | 工厂地址列表（地址 id） |
| 十一 | 关闭订单 | `/trade/api/interface/closeOrder` | 取消 |
| 十二 | 按产品编码查工厂地址 | `/trade/api/interface/queryProductShipAddress` | 产品→地址 |
| 十三 | 查询订单 | `/trade/api/interface/queryOrderInfo` | 详情 |
| 十四 | 修改订单图片 | `/trade/api/interface/updatePrintImage` | 换印花图 |
| 十五 | 已发货订单地址脱敏 | `/trade/api/interface/maskAddress` | 隐私合规 |
| 十六 | 推送订单 | `/trade/api/interface/pushOrder` | 推到工厂 |
| 十七 | 查询异常图片分页列表 | `/trade/api/interface/queryAbnormalImagePage` | 印花异常件 |
| 十八 | 上传 SKU 图片替换并改异常状态 | `/trade/api/interface/uploadAbnormalImage` | 修图重传 |
| 十九 | 同步异常图片处理到分销/工厂 | `/trade/api/interface/syncImageToFactory` | 同步处理结果 |
| 二十 | 查询订单售后详情 | `/trade/api/interface/queryAfterSalesInfo` | 售后单 |
| 二十一 | 申请售后 | `/trade/api/interface/createAfterSales` | 补发/赔付 |
| 二十二 | 更新订单面单 | `/trade/api/interface/updateOrderWaybillData` | 自带面单 |
| 二十三 | 查询订单资金 | `/trade/api/interface/orderFundsPageList` | 扣费明细（对账） |

## 3. 下单 `placeOrder`

### 3.1 订单级字段

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| platformType | integer | 是 | 平台类型：**15 海外自建站，18 国内自建站** |
| subPlatformType | integer | 否 | 实际平台类型：TIKTOK=11、TEMU=13、SHEIN=17、SHOPEE=6、LAZADA=7 |
| sourcePlatformOid | string | 是 | 源平台订单号（唯一性由你保证） |
| platformOrderStatus | string | 是 | 平台订单状态：`NOT_SHIPPED` / `SHIPPED` / `CANCEL` |
| platformRefundStatus | string | 是 | 退款状态：`NO_REFUND` 等 |
| platformOid | string | 是 | 平台订单号（银河侧主键） |
| consigneeName | string | 是 | 收件人 |
| phone | string | 是 | 收件人电话 |
| address | string | 是 | 详细地址 |
| addressOptional | string | 否 | 地址补充 |
| receiverCountry | string | 是 | 国家，如 `US`、`MX` |
| receiverProvince | string | 是 | 省/州 |
| receiverCity | string | 是 | 市 |
| receiverDistrict | string | 否 | 区/县 |
| receiverTown | string | 否 | 乡镇 |
| postCode | string | 否（海外单不能为空） | 邮编 |
| deliveryCourier | string | 否 | 快递：USPS、UPS、FEDEX、IMILE、J&T Express、UniUni、GOFO、CTT、YANWEN、YAMATO、自发货 |
| courierNumber | string | 否 | 快递单号 |
| sellerRemark | string | 否 | 卖家备注 |
| buyerRemark | string | 否 | 买家备注 |
| orderTime | string | 是 | 下单时间 `yyyy-MM-dd HH:mm:ss` |
| selfWaybillFlag | boolean | 否 | 是否自带面单 |
| waybill | string | 否 | 面单 |
| addressId | string | 否 | 工厂发货地址 id（来自接口十/十二） |
| methodForAcqWaybills | number | 否 | 面单获取方式：1 平台面单，2 其他面单 |
| shipLogisticsType | string | 否 | 物流渠道类型 |
| intermodalExpress | string | 否 | 联运快递 |
| goodsList | array | 是 | 商品列表 |

> 自带面单时：`selfWaybillFlag` + `waybill` + `addressId` + `deliveryCourier` + `courierNumber` 一起传。

### 3.2 商品 `goodsList[]`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| platformOid | string | 是 | 平台订单号 |
| platformOllId | string | 是 | 平台子订单号，标记商品唯一性（样例为 `主单号 + 001`） |
| goodsType | integer | 是 | 商品类型：1 普通 |
| title | string | 是 | 商品标题 |
| specification | string | 否 | 规格（颜色/尺码拼接） |
| goodsStatus | string | 是 | `NOT_SHIPPED` 等 |
| refundStatus | string | 是 | `NO_REFUND` 等 |
| sizeCode | string | 是 | 尺码编码 |
| sizeName | string | 是 | 尺码名称 |
| colorCode | string | 是 | 颜色编码 |
| colorName | string | 是 | 颜色名称 |
| styleCode | string | 是 | 款号编码 |
| styleName | string | 是 | 款号名称 |
| craftType | integer | 是 | 工艺：**1 白墨烫画，2 白墨直喷，3 热转印，4 UV** |
| num | integer | 是 | 数量 |
| platformSpuId | string | 否 | 平台 SPU |
| platformSkuId | string | 否 | 平台 SKU |
| remark | string | 否 | 备注 |
| printPosition | string | 否 | 商品级印刷位置：`1` 前、`2` 后、`3` 左、`4` 右；多面 `"1,2"` ⚠️ |
| goodsLabel | object | 否 | 标签 |
| imageList | array | 是 | 图片列表 |

### 3.3 图片 `imageList[]`（关键）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| type | integer | 是 | **1 打印图，2 效果图** |
| imageUrl | string | 是 | 图片 URL |
| imageCode | string | 是 | 图片编码，**同一店铺内唯一** |
| imageName | string | 是 | 图片名称（与编码一致） |
| printDirection | integer | 否 | 印刷位置：1 前、2 后、3 左、4 右 |
| source | integer | 否 | 0 系统（默认）、1 设计器 |

业务规则（原文要点，必须遵守）：

1. 打印图只支持 **PNG**。
2. 打印图会上传到素材库；**若素材库已存在相同 `imageCode`，系统复用旧图、忽略本次传入的图**。所以每张印花必须用唯一 `imageCode`（含设计版本/时间戳），否则改图不生效。
3. 无打印图时：`imageCode` 传 `"不打印"`，`imageUrl` 传 `123`。
4. `source` 默认 0（系统）。

### 3.4 goodsLabel

| 字段 | 说明 |
| --- | --- |
| productCode / productSkuCode / skuSpecName | 货号、SKU、规格（用于打印标签/吊牌） |
| labelCode | 标签编码 |
| productSkuId | 货品 SKU id |
| outLabelName | 文案 |
| europeanLabelUrl | 欧代标签 URL |

## 4. 订单状态机

主单 `orderStatus`：

| 值 | 枚举 | 中文 |
| --- | --- | --- |
| 1 | STORE_AUDIT | 店铺审核中 |
| 2 | PENDING_PUSH | 店铺推送中（待推送） |
| 3 | REVERSE_AUDIT | 反审回电商 |
| 4 | FACTORY_AUDIT | 工厂审核 |
| 5 | IN_PRODUCTION | 生产中 |
| 12 | SHIPPED | 已发货 |
| 13 | CLOSE | 已关闭 |
| 14 | REFUNDING | 退款中 |
| 15 | REFUNDED | 已退款 |

子单 `goodsStatus`：`NOT_SHIPPED` 未发货、`SHIPPED` 已发货、`CLOSE` 已关闭、`CANCEL` 已取消、`COMPLETE` 已完成。

可操作窗口：

- **改单 / 改图 / 推单**：只在 `2 待推送` 或 `3 反审回电商`；一旦推给工厂就不能改。
- 关闭订单：见接口十一（已发货订单要走售后）。
- 地址脱敏：仅对已发货/已关闭订单。

## 5. 各接口参数速查

### 修改订单 `updateOrder`

- 只能改收货信息、平台订单状态；商品只允许改数量/规格/颜色/尺码/工艺，可**新增**商品，**不能删除**。
- 商品标签、欧代标签 URL 若本次不传，会被置空 —— 改单时要整份带上。
- 入参同样含 `order`（同下单订单级字段）+ `goodsUpdateList`（同 goodsList 字段）+ `imageList`。

### 预发货 `preShipped`
`{ "platformOid": "..." }`

### 获取面单 `queryOrderDelivery`
`{ "platformOidList": ["..."] }`（最多 100）
返回：`platformOid`、`trackingNumber`、`waybillDataPath`、`shippingTime`。

### 查询订单状态 `queryOrderStatus`
`{ "platformOidList": [...] }`（≤100）
返回：`platformOid`、`orderStatus`(int)、`orderStateStr`、`childOrderStatus[{ platformOllId, goodsStatus, goodsStatusStr }]`。

### 查询产品/款号/颜色/尺码
- `queryProduct`：`pageIndex`(默认 1)、`pageSize`(默认 1000)；返回 `productCode`、`styleCode`、`colorCode`、`sizeCode`、`unitType`(1 cm/kg、2 in/lbs)、重量等。
- `queryStyle`：返回 `styleCode`、`styleName`、`craftType`（字符串）、图片。
- `queryColor`：`colorCode` / `colorName`。
- `querySize`：`sizeCode` / `sizeName`。

### 工厂地址
- `queryShipAddress`：无参，返回地址列表（`id`、国家/省/市/详细地址、`enabled`）。
- `queryProductShipAddress`：`{ "productCodeList": [...] }`（≤10），返回每个产品可用地址列表。

### 关闭订单 `closeOrder`
`{ "platformOid": "..." }`

### 查询订单 `queryOrderInfo`
`{ "platformOidList": [...] }`（≤100），返回完整订单与商品明细。

### 修改订单图片 `updatePrintImage`
入参含 `platformOid` + `goodsList`（子单 + `imageList`），仅在待推送/反审回电商可用。

### 地址脱敏 `maskAddress`
入参：`platformOid` 等（仅已发货/已关闭订单）。

### 推送订单 `pushOrder`
入参：`platformOidList`（待推送/反审回电商）。
返回：`total`、`failed`、`succeeded`、`errMessages[]`、`appendKeys`。
判定：`successful=true` 且 `data=null` → 全部成功；`data` 非空 → 看 `errMessages`。

### 异常图片流程
1. `queryAbnormalImagePage`：`pageIndex` / `pageSize`，返回异常图片 id、订单、SKU、异常原因、状态。
2. `uploadAbnormalImage`：`{ imageType, images:[{ imageUrl, imageCode }], abnormalLabelNo }`（图片需先上传到可访问 URL）。
3. `syncImageToFactory`：`{ "ids": [2] }`（仅「已处理待同步」状态可同步）。

### 售后
- `queryAfterSalesInfo`：`{ "platformOid": "..." }`，返回售后单主体 + `goodsBOList` + `imageBOList`。
- `createAfterSales`：`orderId`(否)、`platformOid`(是)、`type`(是：3 原单号补发、1 新单号补发、2 赔付)、`applyContent`(是，1–200 字)、`courier`、`expressFee`、`expressRefund`、`checkExpressRefund`、`otherRefund`、`checkOtherRefund`、`goodsList[]`（`goodsId`、`mappingCode`、`refund`、`resendNum`）、`imageList[]`、`uploadPictureList[]`。
- 同一订单同时只能有一张在审售后单，否则报「已有申请单在审核中」。

### 更新面单 `updateOrderWaybillData`
`platformOid`、`addressId`、`waybillDataType`(1 URL、2 base64 文件流)、`courierNumber`、`deliveryCourier`、`waybillData`。

### 订单资金 `orderFundsPageList`（对账用）
`orderType`(2 成品加工单)、`startTime` / `endTime`（`yyyy-MM-dd HH:mm:ss`）、`platformOidList`(≤100)、`courierNumbers`(≤100)、`useBusinessPicture`、`pageIndex`、`pageSize`。
返回 `records[]`：`platformOid`、`orderNumber`、`feeAmount`、`goodsAmount`、`expressAmount`、`expressName`、`discountAmount`、`realTotalAmount`、`createTime` 等。

## 6. 对我们 POD 流程的映射

| 现在（浏览器点） | 以后（API） |
| --- | --- |
| 手工/脚本建单 | 一 placeOrder（订单+子单号=主单号+001…） |
| 改地址、改数量 | 二 updateOrder |
| 换印花图 | 十四 updatePrintImage（**imageCode 必须唯一**） |
| 推给工厂 | 十六 pushOrder |
| 看订单到哪一步 | 五 queryOrderStatus / 十三 queryOrderInfo |
| 拿运单号/面单 | 四 queryOrderDelivery / 二十二 updateOrderWaybillData |
| 取消 | 十一 closeOrder |
| 核对扣了多少钱 | 二十三 orderFundsPageList |
| 报价（原衣/印花价） | 只读报价走 `POST /trade/orderFunds/product/price`（现有 CDP 脚本），**不在本 OpenAPI 文档内** |

## 7. 待实网确认 / 前置条件

1. **密钥**：需要银河后台建「自建站」店铺并取 `密钥`（secretKey）。现有账号是工厂/分销账号，是否已开自建站店铺未知。
2. `platformOllId` 拼写已按 400dpi 读图确认为 `platformOllId`（O + ll + Id），首次实网调用时用一张测试单验证。
3. 商品级 `printPosition`（string）与图片级 `printDirection`（integer）两套字段并存，首次下单建议两者都带。
4. `platformType` 海外=15、国内=18；墨西哥店按 15 走，需确认店铺平台类型设置。
5. 文档未给限流/QPS 说明，批量建单要自己加节流与失败重试（幂等键用 `platformOid` + `platformOllId`）。
