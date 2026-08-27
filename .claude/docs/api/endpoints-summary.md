# 鱼塘 Manager API — 端点摘要 (70 路径 / 74 方法)

来源 `api/manager-api-docs.json` (OpenAPI 3.0.1)。基址为 `https://dld.lesscoding.net/api/` (文档里的 `/xeManager` 未部署, 见 [README.md](./README.md))。
`实际被调用?` 列标记 ✅ = 被 `agent/lib/xechat-api.mjs` 实际调用 (仅 4 个只读查询端点); 其余端点当前 agent 均未使用。

## 游戏管理 (27)

| 方法 | 路径 | 域 | 用途 | 实际被调用? |
|---|---|---|---|---|
| GET | /api/gameInfo/{gameName} | 游戏 | 游戏详情 (按英文名) | ✅ (xechat-api.gameDetail) |
| GET | /api/gameInfo/detail/{id} | 游戏 | 游戏详情 (按 id, 关联文件信息) | ✅ (xechat-api.gameDetail) |
| POST | /api/gameInfo/list | 游戏 | 游戏列表 (分页) | ✅ (xechat-api.gameList) |
| POST | /api/gameInfo/create | 游戏 | 新增游戏 (重名报错, 可带包自动部署) | |
| PUT | /api/gameInfo/update | 游戏 | 修改游戏 | |
| PUT | /api/gameInfo/status | 游戏 | 修改游戏状态 | |
| DELETE | /api/gameInfo/{gameName} | 游戏 | 删除游戏 (逻辑删除) | |
| POST | /api/gameInfo/version/next | 游戏 | 生成并回显新版本号 (major/minor/patch) | |
| POST | /api/gameInfo/upload | 游戏 | 上传部署包 (仅 .tar.gz, 部署并更新版本) | |
| POST | /api/gameInfo/deploy | 游戏 | 复用已上传 fileId 部署 (不重新上传) | |
| POST | /api/gameInfo/current | 游戏 | 当前部署版本 | |
| POST | /api/gameInfo/download | 游戏 | 下载游戏部署包 | |
| POST | /api/gameInfo/history | 游戏 | 部署历史 (分页) | |
| GET | /api/gameInfo/history/{id} | 游戏 | 部署历史详情 | |
| DELETE | /api/gameInfo/history/{id} | 游戏 | 删除部署历史 (逻辑) | |
| POST | /api/category | 游戏 | 新增游戏分类 | |
| POST | /api/category/update | 游戏 | 修改游戏分类 | |
| POST | /api/category/tree | 游戏 | 分类树 (仅启用) | |
| POST | /api/category/list | 游戏 | 分类分页查询 | |
| POST | /api/category/enabled | 游戏 | 分类列表 (仅启用, 扁平) | |
| GET | /api/category/{id} | 游戏 | 分类详情 | |
| DELETE | /api/category/{id} | 游戏 | 删除分类 (禁用, 级联子分类) | |
| POST | /api/server | 游戏 | 新增服务器 | |
| POST | /api/server/update | 游戏 | 修改服务器 | |
| POST | /api/server/page | 游戏 | 服务器分页查询 | |
| GET | /api/server/list | 游戏 | 启用中的服务器列表 (公开) | |
| DELETE | /api/server/{id} | 游戏 | 删除服务器 (逻辑) | |

## 用户 / 角色 / 菜单 (18)

| 方法 | 路径 | 域 | 用途 | 实际被调用? |
|---|---|---|---|---|
| POST | /api/user/register | 用户 | 用户注册 | |
| POST | /api/user/login | 用户 | 用户登录 | |
| POST | /api/user/refresh | 用户 | 刷新 Token | |
| POST | /api/user/roles | 用户 | 分配角色 (全量覆盖) | |
| POST | /api/user/list | 用户 | 分页查询用户 | |
| GET | /api/user/userInfo | 用户 | 当前用户信息 | |
| GET | /api/user/roles/{userId} | 用户 | 按用户查询角色列表 | |
| POST | /api/role | 角色 | 新增角色 | |
| POST | /api/role/update | 角色 | 修改角色 | |
| POST | /api/role/page | 角色 | 角色分页查询 | |
| GET | /api/role/list | 角色 | 角色全部列表 | |
| DELETE | /api/role/{id} | 角色 | 删除角色 (逻辑, 清空关联) | |
| POST | /api/menu | 菜单 | 新增菜单 | |
| POST | /api/menu/update | 菜单 | 修改菜单 | |
| POST | /api/menu/assignMenus | 菜单 | 保存角色-菜单关联 (全量覆盖) | |
| GET | /api/menu/tree | 菜单 | 菜单树 (含隐藏菜单) | |
| GET | /api/menu/roleMenus | 菜单 | 按角色查询已关联菜单 id | |
| DELETE | /api/menu/{id} | 菜单 | 删除菜单 (逻辑, 级联子孙+清关联) | |

## 排行榜 (2)

| 方法 | 路径 | 域 | 用途 | 实际被调用? |
|---|---|---|---|---|
| POST | /api/leaderboard/ranking | 排行榜 | 排行榜查询 | ✅ (xechat-api.leaderboard) |
| POST | /api/leaderboard/submit | 排行榜 | 提交分数 | |

## 文件 (4)

| 方法 | 路径 | 域 | 用途 | 实际被调用? |
|---|---|---|---|---|
| POST | /api/file/upload | 文件 | 上传文件 (需登录, multipart; 按 MD5 去重) | |
| POST | /api/file/page | 文件 | 文件分页查询 (需登录) | |
| GET | /api/file/view/{fileId} | 文件 | 查看文件 (免登录, inline, 支持 Range) | |
| GET | /api/file/download/{fileId} | 文件 | 下载文件 (免登录, attachment, 支持 Range) | |

## 部署历史 (5)

| 方法 | 路径 | 域 | 用途 | 实际被调用? |
|---|---|---|---|---|
| POST | /api/deployHistory | 部署 | 新增部署历史 | |
| POST | /api/deployHistory/update | 部署 | 修改部署历史 | |
| POST | /api/deployHistory/list | 部署 | 部署历史分页查询 | |
| GET | /api/deployHistory/{id} | 部署 | 部署历史详情 | |
| DELETE | /api/deployHistory/{id} | 部署 | 删除部署历史 (逻辑) | |

## 其它 (18)

| 方法 | 路径 | 域 | 用途 | 实际被调用? |
|---|---|---|---|---|
| POST | /api/storage/save | 存档 | 保存存档 | |
| POST | /api/storage/load | 存档 | 读取存档 | |
| POST | /api/storage/delete | 存档 | 删除存档 | |
| GET | /api/storage/slots/{gameInfoId} | 存档 | 存档槽位列表 | |
| POST | /api/dict/types | 字典 | 字典类型列表 (已启用) | |
| POST | /api/dict/types/list | 字典 | 字典类型分页查询 | |
| POST | /api/dict/type | 字典 | 新增字典类型 | |
| POST | /api/dict/type/update | 字典 | 修改字典类型 | |
| POST | /api/dict/items/type | 字典 | 字典项列表 (按类型编码, 含禁用) | |
| POST | /api/dict/item | 字典 | 新增字典项 | |
| POST | /api/dict/item/update | 字典 | 修改字典项 | |
| DELETE | /api/dict/type/{id} | 字典 | 删除字典类型 (禁用) | |
| DELETE | /api/dict/item/{id} | 字典 | 删除字典项 (禁用) | |
| POST | /api/achievement/progress | 成就 | 更新成就进度 | |
| GET | /api/achievement/list/{gameInfoId} | 成就 | 查询用户成就列表 | |
| POST | /api/operLog/list | 日志 | 操作日志分页查询 | |
| DELETE | /api/operLog/clear | 日志 | 清空操作日志 (物理删除) | |
| POST | /api/dashboard/stats | 仪表盘 | 仪表盘统计指标 | |

## 其它文件

- `api/manager-api-docs.json` — OpenAPI 3.0.1 原始文档 (上述所有端点的唯一来源)。
- `api/register_batch.py` — 批量注册测试脚本 (**不在项目核心流程**; 当前仓库中未发现该文件, 可能已被清理)。
- `api/register_1000.jsonl` / `api/register_100k.jsonl` / `api/smoke_test.jsonl` — 批量注册 / 冒烟测试结果数据 (同上, 当前仓库中未发现)。

## 备注

- 4 个路径各含两个方法: `/gameInfo/{gameName}`、`/gameInfo/history/{id}`、`/deployHistory/{id}`、`/category/{id}` (均为 GET + DELETE)。
- ✅ 标记仅 4 个: `gameList` → `/api/gameInfo/list`; `gameDetail` → `/api/gameInfo/detail/{id}` 与 `/api/gameInfo/{gameName}`; `leaderboard` → `/api/leaderboard/ranking`。
- 创建/关闭/列出游戏房间 (`create_room` / `close_room` / `list_rooms`) 走 WS 协议 (`CREATE_GAME_ROOM` / `GAME_ROOM`), **不在**本 HTTP API 中。
