# 鱼塘 (Xechat) 辅助服务参考

> 来源：上游源码 `xechat-server/service|util`、`xechat-commons/constants` 与仓库资源文件。
> 这些是聊天服务器接入的第三方/内部辅助能力：和风天气、百度翻译、IP 归属地、服务器列表、城市库、服务端配置。

## 1. 和风天气（HeFeng）服务

### 1.1 接口常量（HeFengWeatherConstants）

| 常量 | 值 |
|---|---|
| `HE_FENG_HOST` | `https://devapi.qweather.com/v7` |
| `HE_FENG_WEATHER_NOW` | `https://devapi.qweather.com/v7/weather/now` |
| `HE_FENG_WEATHER_3D` | `https://devapi.qweather.com/v7/weather/3d` |
| `HE_FENG_WEATHER_7D` | `https://devapi.qweather.com/v7/weather/7d` |
| `HE_FENG_AIR_NOW` | `https://devapi.qweather.com/v7/air/now`（仅配置，未实际调用） |
| `HE_FENG_SUCCESS_CODE` | `"200"` |

### 1.2 请求参数（GET form）

| 参数 | 取值 |
|---|---|
| `key` | 和风 API key（来自 `WeatherConfig.appKey`；未配置时报"参数缺失"） |
| `location` | 地区 ID 或经纬度（WEATHER action 传城市库解析出的 `locationId`，如 `101010100`） |
| `lang` | `Lang` 枚举 value（默认 `zh`；实现里 getWeatherNow/3d 硬编码 `Lang.ZH`） |
| `unit` | `Unit` 枚举：`m`（公制）/ `i`（英制）（实现里硬编码 `Unit.M`） |

```http
GET https://devapi.qweather.com/v7/weather/now?key=YOUR_KEY&location=101010100&lang=zh&unit=m
GET https://devapi.qweather.com/v7/weather/7d?key=YOUR_KEY&location=101010100&lang=zh&unit=m
```

### 1.3 响应结构（服务端包装实体，不会直接发给客户端）

| 字段 | 类型 | 含义 |
|---|---|---|
| `code` | String | API 状态码（=`"200"` 才算成功） |
| `updateTime` | String | 最近更新时间 |
| `fxLink` | String | 响应式页面链接 |
| `now` | CurrentWeather | 实况（仅 now 接口） |
| `daily` | List&lt;FutureWeather&gt; | 逐日预报（仅 3d/7d 接口） |

**CurrentWeather**（全 String，注意源码拼写 `winScale`/`winSpeed`）：`temp`、`feelsLike`、`icon`、`text`、`windPower`、`wind360`、`windDir`、`winScale`、`winSpeed`、`humidity`、`precip`、`pressure`、`vis`、`cloud`、`dew`。

**FutureWeather**（全 String）：`fxDate`、`week`（服务端按 fxDate 计算填充）、`sunrise/sunset`、`moonrise/moonset`、`moonPhase/moonPhaseIcon`、`tempMax/tempMin`、`iconDay/textDay`、`iconNight/textNight`、`wind360Day/windDirDay/windScaleDay/windSpeedDay`、`wind360Night/windDirNight/windScaleNight/windSpeedNight`、`precip`、`uvIndex`、`humidity`、`pressure`、`vis`、`cloud`。

### 1.4 WEATHER action 完整流程（见 [ws-protocol.md](ws-protocol.md) §8）

1. `CityService.getOne(location)` 按关键字在 `locationName`/`admName1`/`admName2` 中模糊匹配，取第一条 CityInfo。
2. 以 `locationId` 作为和风 `location` 调 now / 3d / 7d。
3. 异常（含城市未找到的 NPE）→ 该用户收 SYSTEM "天气查询异常，请联系管理员！"。
4. 成功 → 组装 ConsoleTable 文本，以 SYSTEM **仅单发请求者**：
   - 实时：表头 `日期|天气|当前温度|体感温度`，行 = 今天 / `text` / `temp℃` / `feelsLike℃`。
   - 预报：表头 `日期|天气|温度`，行 = `fxDate` / `textDay[转textNight]` / `tempMin℃ ~ tempMax℃`。
   - 消息 = `CRLF + locationName + " 天气预报" + CRLF + 表格`。

**失败模式**：`location`/`apiUrl`/`key` 为空 → `RuntimeException("接口调用失败：参数缺失")`；非 2xx → "接口调用失败"；`code != "200"` → "API状态码异常"。

## 2. 百度翻译（BaiDuFyUtil）

- 接口：`POST https://fanyi-api.baidu.com/api/trans/vip/translate`；固定 `APP_SALT = "xechat"`；en → zh。
- **未配置 appId/appKey 时原样返回**（默认行为，agent 依赖的空配置路径）。

### 2.1 请求表单

| 参数 | 值 |
|---|---|
| `q` | 待翻译文本 |
| `from` / `to` | `en` / `zh` |
| `appid` | 百度翻译 app id |
| `salt` | `xechat` |
| `sign` | `md5(appId + query + salt + appKey)` |

### 2.2 跳过条件（任一命中即不翻译）

含中文/非 ASCII（`!query.matches("^[\x00-\xff]+$")`）、URL、纯数字、时间、邮箱、`@` 开头。

### 2.3 响应与失败

- 成功：`trans_result[0].dst` 需 `UnicodeUtil.toString` 解码；返回 `{query}（机翻：{dst}）`（**全角括号**）。
- `error_code` 非空 → 返回空串 `""`。
- LFU 缓存 1000 条；**缓存命中返回未加"（机翻：）"前缀的原文**（源码事实，格式不一致）。
- 每条 TEXT 聊天消息自动经过"敏感词过滤 → 百度机翻"管线（[ws-protocol.md](ws-protocol.md) §6.2）。

## 3. IP 归属地（ip2region）

### 3.1 行为（Ip2RegionServiceImpl）

- `org.lionsoul.ip2region.xdb.Searcher` VectorIndex 方式（索引只加载一次）。
- `search(ip)` 返回 `国家|区域|省份|城市|ISP` 分隔串；为空 → 抛"解析地理位置异常"。
- 正则解析出 `country/province/city/isp`（`areaCode` 捕获但未写入实体；`area/street/village` 不填）。
- `country == "0"`（未知区域）→ 返回 `IpRegion{ip, country="未知"}`。
- 任何异常 → 返回 `IpRegion{ip, country="未知"}`（不抛出）。
- 数据库下载地址（源码注释）：`https://gitee.com/lionsoul/ip2region/tree/master/data`。

### 3.2 IpRegion 返回字段

`ip`、`country`、`province`（空值回退"未知"）、`city`、`area`（不填）、`street`（不填）、`village`（不填）、`isp`。
`toString()`：country/province/city/area/street/village/isp 依次拼接（null 或 `"0"` 跳过）。

### 3.3 省份简称映射（IpConstants.SHORT_PROVINCE，共 39 条）

| 省份键 | 简称 | 省份键 | 简称 |
|---|---|---|---|
| 北京市 / 北京 | 京 | 湖北省 | 鄂 |
| 天津市 / 天津 | 津 | 湖南省 | 湘 |
| 河北省 | 冀 | 广东省 | 粤 |
| 山西省 | 晋 | 广西壮族自治区 | 桂 |
| 内蒙古自治区 | 蒙 | 海南省 | 琼 |
| 辽宁省 | 辽 | 四川省 | 川 |
| 吉林省 | 吉 | 贵州省 | 贵 |
| 黑龙江省 | 黑 | 云南省 | 滇 |
| 上海市 / 上海 | 沪 | 重庆市 / 重庆 | 渝 |
| 江苏省 | 苏 | 西藏自治区 | 藏 |
| 浙江省 | 浙 | 陕西省 | 陕 |
| 安徽省 | 皖 | 甘肃省 | 甘 |
| 福建省 | 闽 | 青海省 | 青 |
| 江西省 | 赣 | 宁夏回族自治区 | 宁 |
| 山东省 | 鲁 | 新疆維吾尔自治区 | 新 |
| 河南省 | 豫 | 香港特别行政区 | 港 |
| | | 澳门特别行政区 | 澳 |
| | | 台湾省 | 台 |
| | | 未知 | 中国 |

> 注：北京市/北京、天津市/天津、上海市/上海、重庆市/重庆 各为独立键（共 39 条）。登录进塘通知 `[简称·用户名]进入了鱼塘！` 即用此映射，未命中回退国家名（[ws-protocol.md](ws-protocol.md) §5.3）。

## 4. 服务器列表

- 仓库文件 `server_list.json`（示例/默认数据）：

```json
[
  { "name": "充电鸭鱼塘", "ip": "lesscoding.net", "port": 33858, "version": "2.0.0" },
  { "name": "官方魚塘", "ip": "xechat.xeblog.cn", "port": 33858, "version": "1.6.7-beta" }
]
```

- 字段：`name`（名称）、`ip`（主机）、`port`（TCP 端口）、`version`（服务端版本）。
- 前端实际运行时列表来自 **管理端 HTTP API**：`https://dld.lesscoding.net/api/server/list`（即 [manager-api-docs.json](manager-api-docs.json) 的 `GET /api/server/list`），返回 JSON 数组或 `{data:[...]}`。
- 连通性探测：TCP `http://host:port`（500ms）、WS `ws://host:(port+1)/xechat`（2s）—— **WebSocket 通道在 TCP 端口 +1**（agent 连 `XE_PORT=33859` 即此）。
- `version` 字段用于登录时 `pluginVersion`（仅 IDEA 平台比对）。

## 5. 城市列表资源（China-City-List-latest.json）

- 位置：`xechat-server/src/main/resources/db/China-City-List-latest.json`，顶层 JSON 数组（3204 条），每条与 CityInfo 同构。
- CityInfo 字段：`locationId`（和风 LocationID）、`adCode`、`locationName`、`admName1`（省）、`admName2`（市/州）、`latitude`、`longitude`。
- 用途：`HeFengCityServiceImpl.getOne(keyword)` 按 `locationName/admName1/admName2` 包含匹配取第一条，为 WEATHER action 解析城市 → locationId。

## 6. 服务端配置汇总（ConfigUtil / ServerConfig / config.setting）

| 字段 | 命令行参数 | config.setting 键 | 默认/说明 |
|---|---|---|---|
| `port` | `-p` | `[SERVER] port` | 默认 `1024`（线上 `33858`） |
| `enableWS` | `-enableWS` | `[SERVER] enableWS` | **代码级默认 false**；随附 config.setting 含 `enableWS = true` |
| `sensitiveWordPath` | `-swfile` | `[SENSITIVE_WORD] file` | 占位符 `${SW_FILE}` → null |
| `weatherApiKey` | `-weather` | `[WEATHER] key` | 占位符 `${WEATHER_KEY}` → null |
| `translationAppId` | `-fyAppId` | `[TRANSLATION] appId` | 占位符 `${BD_APP_ID}` → null |
| `translationAppKey` | `-fyAppKey` | `[TRANSLATION] appKey` | 占位符 `${BD_APP_KEY}` → null |
| `ip2RegionPath` | `-ipfile` | `[IP_SEARCH] ip2Region_path` | 占位符 `${IP2REGION_PATH}` → null |
| `token` | `-token` | `[ADMIN] token` | 占位符 `${TOKEN}` → null |

两份 config.setting：
- `xechat-server/config.setting`（模块根）：各键为 `${...}` 占位符，`port=1024`、`enableWS=true`。
- `xechat-server/src/main/resources/config.setting`：`[WEATHER]` 组为 `projectId/tokenId`（与代码按 `key` 读取**不匹配**，不会被采用，属历史遗留）；`[SENSITIVE_WORD] file=/opt/apps/xechat-server/data/db/keywords.txt`、`[ADMIN] token=LeftWing.8-`、`port=33858`。

启动装配（XEChatServer.main）：敏感词/和风天气/百度翻译/ip2region 分别按上述配置非空才装配；未装配时退化行为：天气→调接口报"参数缺失"、翻译→原样返回、IP→country="未知"。
