# InkLayer Vue Starter

Official Vue starter template for **InkLayer** — a PDF annotation SDK built on PDF.js.

This project demonstrates how to quickly integrate InkLayer into a Vue 3 application.

👉 Live Demo: https://inklayer.dev  
👉 Vue SDK: https://github.com/Laomai-codefee/inklayer-vue  
👉 React SDK: https://github.com/Laomai-codefee/inklayer-react  

---

## 🚀 Quick Start

### Install dependencies

```bash
npm install
or
pnpm install
```

### Run project

```bash
npm run dev
or
pnpm dev
```

### Open in browser
```bash
http://localhost:5173
```

## 📦 What This Starter Includes

### This starter shows the minimal integration of InkLayer in a Vue 3 app:

- PDF rendering based on PDF.js
- Annotation system (highlight, selection, etc.)
- Annotation sidebar
- Save annotation output
- Vue plugin integration

## 🧩 Basic Usage

### 1. Plugin Setup (Required)

```typescript
import { createApp } from 'vue'
import { inklayerVuePlugin } from 'inklayer-vue'
import App from './App.vue'

const app = createApp(App)

app.use(inklayerVuePlugin)

app.mount('#app')
```

### 2. Component Usage
```typescript
<script setup lang="ts">
import { PdfAnnotator } from 'inklayer-vue'
import 'inklayer-vue/style'
</script>

<template>
  <PdfAnnotator
    url="https://inklayer.dev/inklayer-demo.pdf"
    :user="{ id: 'demo', name: 'Demo User' }"
    :layoutStyle="{ width: '100vw', height: '100vh' }"
    :defaultShowAnnotationsSidebar="true"
    @save="(annotations) => {
      console.log('saved:', annotations)
    }"
  />
</template>
```
## 📄 How It Works
- Load PDF via PDF.js
- Render annotation layer on top of PDF pages
- User creates highlights / comments
- SDK emits structured annotation data via onSave

## 📊 Output Data
`onSave` returns structured annotation data:
```typescript
[
  {
    id: "annotation-id",
    kind: "text-markup",
    target: { ... },
    payload: { ... },
    meta: { ... }
  }
]
```
### This data can be:
- Stored in database
- Re-rendered later
- Synced across systems

## 💡 Important Notes
### Plugin is required
Vue version requires plugin initialization:
```typescript
app.use(inklayerVuePlugin)
```
**Without this, annotation system will not initialize correctly.**

## 🧪 Purpose
### This starter is designed for:
- Quick SDK evaluation
- Integration testing
- Reference implementation
- Project bootstrap

## 📚 Next Steps
- Docs: https://inklayer.dev/docs
- React SDK: https://github.com/Laomai-codefee/inklayer-react
- Vue SDK: https://github.com/Laomai-codefee/inklayer-vue
- React Starter: https://github.com/Laomai-codefee/inklayer-react-starter

## Document text pipeline

Native PDF text extraction, canonical text rules, page artifacts, quality heuristics, job recovery, and the future OCR boundary are documented in [docs/document-text-pipeline.md](docs/document-text-pipeline.md).
