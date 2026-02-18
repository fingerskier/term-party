 Plan to implement                                                                    │
│                                                                                      │
│ Plan: Hybrid Semantic + Exact Text Search for Dude Browser                           │
│                                                                                      │
│ Context                                                                              │
│                                                                                      │
│ The Dude browser's search currently uses SQL LIKE substring matching. The dude       │
│ database already stores 384-dim L2-normalized embeddings (F32_BLOB(384)) generated   │
│ by all-MiniLM-L6-v2. We want to use these for semantic search while keeping exact    │
│ text matching as a complement.                                                       │
│                                                                                      │
│ User requirement: Search returns top 10 semantic results + up to 3 exact text        │
│ matches, deduplicated.                                                               │
│                                                                                      │
│ Limitation: better-sqlite3 can't call libSQL's native vector_top_k(). We must read   │
│ embedding blobs and compute cosine similarity in JavaScript.                         │
│                                                                                      │
│ Changes                                                                              │
│                                                                                      │
│ 1. package.json — Add @huggingface/transformers dependency                           │
│                                                                                      │
│ "dependencies": {                                                                    │
│   "@huggingface/transformers": "^3.0.0",                                             │
│   ...                                                                                │
│ }                                                                                    │
│                                                                                      │
│ Also add to asarUnpack in the build section so ONNX runtime binaries aren't packed:  │
│ "asarUnpack": [                                                                      │
│   "node_modules/node-pty/**",                                                        │
│   "node_modules/better-sqlite3/**",                                                  │
│   "node_modules/@huggingface/**",                                                    │
│   "node_modules/onnxruntime-node/**"                                                 │
│ ]                                                                                    │
│                                                                                      │
│ 2. main.js — Add embedding pipeline + rewrite search handler                         │
│                                                                                      │
│ a) Add lazy-loaded embedding pipeline (after openDudeDb block, ~line 158):           │
│                                                                                      │
│ - A getEmbedder() async function that lazy-loads @huggingface/transformers via       │
│ dynamic import() (it's ESM-only)                                                     │
│ - Uses pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2') — same model as     │
│ dude-claude-plugin                                                                   │
│ - Cache the pipeline instance after first load                                       │
│                                                                                      │
│ b) Add cosineSimilarity() helper:                                                    │
│                                                                                      │
│ - Parse embedding blob from DB as Float32Array (384 floats)                          │
│ - Compute dot product (vectors are already L2-normalized, so dot = cosine)           │
│                                                                                      │
│ c) Add buildFilterSQL() helper to share filter logic between search paths:           │
│                                                                                      │
│ - Extracts the repeated kind/status/project filter clause building                   │
│                                                                                      │
│ d) Rewrite dude-search handler (lines 495-522) to be async:                          │
│                                                                                      │
│ 1. Generate query embedding via getEmbedder()                                        │
│ 2. SEMANTIC: Fetch all records with non-null embeddings (applying filters)           │
│    - Compute cosine similarity for each                                              │
│    - Sort by similarity DESC, take top 10 (threshold >= 0.3)                         │
│ 3. EXACT: SQL LIKE query for title/body match (applying filters)                     │
│    - LIMIT 3                                                                         │
│ 4. Merge: combine both arrays, deduplicate by record id                              │
│    - Semantic results first, then exact matches not already present                  │
│ 5. Return combined array                                                             │
│                                                                                      │
│ Files Modified                                                                       │
│                                                                                      │
│ File: package.json                                                                   │
│ Change: Add @huggingface/transformers dep, update asarUnpack                         │
│ ────────────────────────────────────────                                             │
│ File: main.js                                                                        │
│ Change: Add embedding pipeline, rewrite dude-search handler (~lines 495-522)         │
│                                                                                      │
│ Files NOT Modified                                                                   │
│                                                                                      │
│ - preload.js — IPC contract unchanged (dudeSearch(query, filters))                   │
│ - renderer.js — Already consumes results generically as array of {id, kind, title,   │
│ status, project, updated_at}                                                         │
│                                                                                      │
│ Potential Issues                                                                     │
│                                                                                      │
│ 1. ESM import: @huggingface/transformers is ESM-only. Must use const { pipeline } =  │
│ await import('@huggingface/transformers') (dynamic import works in CJS/Electron)     │
│ 2. First search latency: Model download + load on first query (~23MB model, cached   │
│ after). Search will be slower the first time.                                        │
│ 3. Buffer alignment: The F32_BLOB from better-sqlite3 arrives as a Node Buffer. Need │
│  to handle byte offset alignment when creating Float32Array.                         │
│ 4. Records without embeddings: Filter out records where embedding IS NULL for the    │
│ semantic path; they'll still be found via exact text match.                          │
│                                                                                      │
│ Verification                                                                         │
│                                                                                      │
│ 1. npm install — installs @huggingface/transformers, postinstall rebuilds            │
│ better-sqlite3                                                                       │
│ 2. npm start — app launches                                                          │
│ 3. Click "Dude" sidebar, type a search query                                         │
│ 4. Results should show semantically relevant records (not just substring matches)    │
│ 5. Exact phrase matches should appear even if they have low semantic similarity      │
╰──────────────────────────────────────────────────────────────────────────────────────╯
