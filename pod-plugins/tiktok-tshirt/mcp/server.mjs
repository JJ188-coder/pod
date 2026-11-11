#!/usr/bin/env node
// Thin stdio MCP entry. The implementation lives in lib/ so the marketplace
// package stays self-contained (no import into another repository).
import { mcpServer } from '../lib/tiktok-tshirt.mjs';

mcpServer();
