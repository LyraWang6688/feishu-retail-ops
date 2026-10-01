> **Historical reference (legacy Trae document).**
> 本文档于 2026-10-01 从 `.trae/documents/` 迁移至 `docs/archive/legacy-trae/`，正文保持原样。
> 它记录的是 box2bitable 微信小程序时期的技术架构设想，不代表当前架构。
> 当前文档索引见 `docs/README.md`。

## 1.Architecture design

```mermaid
graph TD
  A[微信小程序] --> B[Backend Express Server]
  B --> C[Doubao LLM API]
  B --> D[Feishu Bitable API]
  B --> E[Supabase Database]
```

## 2.Technology Description

* Frontend: 微信小程序原生（WXML/WXSS/JS）

* Backend: Express\@4 + Node.js\@24

* Database: Supabase (PostgreSQL)

* LLM Service: 豆包大模型API

* 文件存储: Supabase Storage

## 3.Route definitions

| Page Route | Purpose |
|---|---|
| /pages/home/home | 首页：数据录入 / 数据查询 |
| /pages/entry/entry | 录入模块选择：采购/销售/库存 |
| /pages/index/index | 图片上传与识别入口 |
| /pages/review/review | 人工复核与同步（含失败重试） |
| /pages/query/query | 库存查询（按货号） |

## 4.API definitions

### 4.1 图片上传与识别API

```
POST /api/recognition/upload
```

Request:

| Param Name | Param Type | isRequired | Description |
| ---------- | ---------- | ---------- | ----------- |
| image      | File       | true       | 鞋盒标签图片文件 |
| module     | string     | true       | purchase / sales / inventory |

Response:

| Param Name | Param Type | Description                         |
| ---------- | ---------- | ----------------------------------- |
| task\_id   | string     | 识别任务ID                              |
| status     | string     | 任务状态 (pending/processing/completed) |
| results    | array      | 识别结果数组                              |

### 4.2 识别结果获取API

```
（可选）由业务决定是否需要拆分为“异步查询结果”接口
```

Response:

| Param Name | Param Type | Description |
| ---------- | ---------- | ----------- |
| task\_id   | string     | 任务ID        |
| results    | array      | 详细的识别结果     |
| confidence | number     | 识别置信度       |

### 4.3 数据同步API

```
POST /api/sync
```

Request:

| Param Name      | Param Type | isRequired | Description |
| --------------- | ---------- | ---------- | ----------- |
| task\_id        | string     | true       | 识别任务ID      |
| reviewed\_data  | array      | true       | 人工复核后的数据（支持多条） |
| module          | string     | true       | purchase / sales / inventory |

### 4.4 库存查询API

```
GET /api/query/inventory?item_no=xxx
```

## 5.Server architecture diagram

```mermaid
graph TD
  A[Client / Frontend] --> B[Auth Middleware]
  B --> C[Upload Controller]
  B --> D[Recognition Controller]
  B --> E[Sync Controller]
  
  C --> F[File Service]
  D --> G[Doubao LLM Service]
  E --> H[Feishu Bitable Service]
  
  F --> I[Supabase Storage]
  G --> J[Supabase Database]
  H --> K[Feishu API]

  subgraph Server
    B
    C
    D
    E
    F
    G
    H
  end
```

## 6.Data model

### 6.1 Data model definition

```mermaid
erDiagram
  USER ||--o{ TASK : creates
  TASK ||--o{ IMAGE : contains
  IMAGE ||--o{ RECOGNITION_RESULT : has
  TASK ||--o{ SKU_AGGREGATION : produces
  SKU_AGGREGATION ||--o{ SYNC_RECORD : generates

  USER {
    string id PK
    string feishu_id UK
    string name
    string email
    string role
    timestamp created_at
  }
  
  TASK {
    string id PK
    string user_id FK
    string status
    integer total_images
    integer processed_images
    timestamp created_at
    timestamp updated_at
  }
  
  IMAGE {
    string id PK
    string task_id FK
    string storage_path
    string filename
    integer file_size
    timestamp uploaded_at
  }
  
  RECOGNITION_RESULT {
    string id PK
    string image_id FK
    string brand
    string model
    string size
    string color
    string sku_code
    float confidence
    json raw_data
    boolean is_reviewed
    timestamp created_at
  }
  
  SKU_AGGREGATION {
    string id PK
    string task_id FK
    string sku_code
    string brand
    string model
    integer total_quantity
    json details
    timestamp created_at
  }
  
  SYNC_RECORD {
    string id PK
    string aggregation_id FK
    string bitable_record_id
    string status
    json sync_data
    string error_message
    timestamp sync_time
  }
```

### 6.2 Data Definition Language

用户表 (users)

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feishu_id VARCHAR(100) UNIQUE NOT NULL,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(255),
  role VARCHAR(20) DEFAULT 'warehouse_manager' CHECK (role IN ('warehouse_manager', 'admin')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_users_feishu_id ON users(feishu_id);
```

识别任务表 (recognition\_tasks)

```sql
CREATE TABLE recognition_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  total_images INTEGER DEFAULT 0,
  processed_images INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_tasks_user_id ON recognition_tasks(user_id);
CREATE INDEX idx_tasks_status ON recognition_tasks(status);
```

图片表 (task\_images)

```sql
CREATE TABLE task_images (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES recognition_tasks(id),
  storage_path VARCHAR(500) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  file_size INTEGER,
  uploaded_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_images_task_id ON task_images(task_id);
```

识别结果表 (recognition\_results)

```sql
CREATE TABLE recognition_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  image_id UUID NOT NULL REFERENCES task_images(id),
  brand VARCHAR(100),
  model VARCHAR(200),
  size VARCHAR(50),
  color VARCHAR(100),
  sku_code VARCHAR(100),
  confidence FLOAT,
  raw_data JSONB,
  is_reviewed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_results_image_id ON recognition_results(image_id);
CREATE INDEX idx_results_sku ON recognition_results(sku_code);
```

SKU聚合表 (sku\_aggregations)

```sql
CREATE TABLE sku_aggregations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES recognition_tasks(id),
  sku_code VARCHAR(100) NOT NULL,
  brand VARCHAR(100),
  model VARCHAR(200),
  total_quantity INTEGER DEFAULT 0,
  details JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_aggregations_task_id ON sku_aggregations(task_id);
CREATE INDEX idx_aggregations_sku ON sku_aggregations(sku_code);
```

同步记录表 (sync\_records)

```sql
CREATE TABLE sync_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregation_id UUID NOT NULL REFERENCES sku_aggregations(id),
  bitable_record_id VARCHAR(100),
  status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
  sync_data JSONB,
  error_message TEXT,
  sync_time TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 创建索引
CREATE INDEX idx_sync_aggregation_id ON sync_records(aggregation_id);
CREATE INDEX idx_sync_status ON sync_records(status);
```

\-- 权限设置
GRANT SELECT ON ALL TABLES TO anon;
GRANT ALL PRIVILEGES ON ALL TABLES TO authenticated;
