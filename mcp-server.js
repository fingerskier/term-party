#!/usr/bin/env node

/**
 * term-party MCP Server
 *
 * Provides scratchpad file access and vector search to AI agents via MCP stdio protocol.
 *
 * Usage:
 *   node mcp-server.js
 *
 * Environment:
 *   TERM_PARTY_SCRATCHPAD - path to scratchpad directory (required)
 *
 * Agent MCP config:
 *   { "command": "node", "args": ["<path-to-mcp-server.js>"], "env": { "TERM_PARTY_SCRATCHPAD": "<path>" } }
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');

const scratchpadDir = process.env.TERM_PARTY_SCRATCHPAD;
if (!scratchpadDir) {
  console.error('TERM_PARTY_SCRATCHPAD environment variable is required');
  process.exit(1);
}

// Ensure scratchpad dir exists
try {
  fs.mkdirSync(scratchpadDir, { recursive: true });
} catch {}

// --- Vector search helpers ---

const VECTOR_DIM = 128;

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
}

function hashVector(text) {
  const vec = new Float32Array(VECTOR_DIM);
  const tokens = tokenize(text);
  for (const token of tokens) {
    let hash = 0;
    for (let i = 0; i < token.length; i++) {
      hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
    }
    const bucket = ((hash % VECTOR_DIM) + VECTOR_DIM) % VECTOR_DIM;
    vec[bucket] += 1;
  }
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  }
  return vec;
}

// --- LanceDB (lazy init) ---

let lanceDb = null;
let lanceTable = null;

async function initLanceDb() {
  try {
    const lancedb = require('@lancedb/lancedb');
    const userDataDir = path.dirname(scratchpadDir);
    const dbPath = path.join(userDataDir, 'scratchpad.lance');
    lanceDb = await lancedb.connect(dbPath);
    const tableNames = await lanceDb.tableNames();
    if (tableNames.includes('documents')) {
      lanceTable = await lanceDb.openTable('documents');
    }
  } catch (err) {
    console.error('LanceDB not available in MCP server:', err.message);
  }
}

async function semanticSearch(query, limit = 10) {
  if (!lanceTable) return [];
  try {
    const qVec = Array.from(hashVector(query));
    const results = await lanceTable.search(qVec).limit(limit).toArray();
    return results.map(r => ({
      path: r.path,
      name: r.name,
      score: r._distance != null ? 1 / (1 + r._distance) : 0,
      snippet: r.content ? r.content.slice(0, 200) : '',
    }));
  } catch {
    return [];
  }
}

// --- File helpers ---

function resolveSafe(relativePath) {
  const resolved = path.resolve(scratchpadDir, relativePath);
  if (!resolved.startsWith(scratchpadDir)) {
    throw new Error('Path traversal not allowed');
  }
  return resolved;
}

function listFilesRecursive(dirPath, relativeTo, results = []) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = relativeTo ? `${relativeTo}/${entry.name}` : entry.name;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        listFilesRecursive(fullPath, relPath, results);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          results.push({
            path: relPath,
            name: entry.name,
            size: stat.size,
            mtime: stat.mtimeMs,
          });
        } catch {}
      }
    }
  } catch {}
  return results;
}

function textSearch(query, limit = 10) {
  const lower = query.toLowerCase();
  const results = [];
  const files = listFilesRecursive(scratchpadDir, '');
  for (const file of files) {
    try {
      const fullPath = path.join(scratchpadDir, file.path);
      const content = fs.readFileSync(fullPath, 'utf-8');
      const nameMatch = file.name.toLowerCase().includes(lower);
      const contentMatch = content.toLowerCase().includes(lower);
      if (nameMatch || contentMatch) {
        let snippet = '';
        if (contentMatch) {
          const idx = content.toLowerCase().indexOf(lower);
          const start = Math.max(0, idx - 60);
          const end = Math.min(content.length, idx + query.length + 60);
          snippet = (start > 0 ? '...' : '') + content.slice(start, end) + (end < content.length ? '...' : '');
        }
        results.push({
          path: file.path,
          name: file.name,
          score: nameMatch ? 1.0 : 0.5,
          snippet,
        });
      }
    } catch {}
  }
  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// --- MCP Server setup ---

const server = new McpServer({
  name: 'term-party-scratchpad',
  version: '1.0.0',
});

server.tool(
  'list_files',
  'List all files in the shared scratchpad directory with metadata',
  {},
  async () => {
    const files = listFilesRecursive(scratchpadDir, '');
    return {
      content: [{ type: 'text', text: JSON.stringify(files, null, 2) }],
    };
  }
);

server.tool(
  'read_file',
  'Read file content from the scratchpad',
  { path: z.string().describe('Relative path to the file within the scratchpad') },
  async ({ path: relPath }) => {
    try {
      const fullPath = resolveSafe(relPath);
      const content = fs.readFileSync(fullPath, 'utf-8');
      return {
        content: [{ type: 'text', text: content }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'write_file',
  'Write or update a file in the scratchpad',
  {
    path: z.string().describe('Relative path to the file within the scratchpad'),
    content: z.string().describe('File content to write'),
  },
  async ({ path: relPath, content }) => {
    try {
      const fullPath = resolveSafe(relPath);
      const dir = path.dirname(fullPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(fullPath, content, 'utf-8');
      return {
        content: [{ type: 'text', text: `Written ${content.length} bytes to ${relPath}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'delete_file',
  'Delete a file from the scratchpad',
  { path: z.string().describe('Relative path to the file within the scratchpad') },
  async ({ path: relPath }) => {
    try {
      const fullPath = resolveSafe(relPath);
      fs.unlinkSync(fullPath);
      return {
        content: [{ type: 'text', text: `Deleted ${relPath}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: ${err.message}` }],
        isError: true,
      };
    }
  }
);

server.tool(
  'search',
  'Search scratchpad files by text and semantic similarity',
  {
    query: z.string().describe('Search query'),
    limit: z.number().optional().default(10).describe('Max results to return'),
  },
  async ({ query, limit }) => {
    // Text search
    const textResults = textSearch(query, limit);

    // Vector search (if available)
    const vectorResults = await semanticSearch(query, limit);

    // Merge results
    const merged = new Map();
    for (const r of textResults) {
      merged.set(r.path, { ...r });
    }
    for (const r of vectorResults) {
      if (merged.has(r.path)) {
        merged.get(r.path).score += r.score;
      } else {
        merged.set(r.path, { ...r });
      }
    }

    const results = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

// --- Start ---

async function main() {
  await initLanceDb();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('term-party MCP server started');
}

main().catch((err) => {
  console.error('Failed to start MCP server:', err);
  process.exit(1);
});
