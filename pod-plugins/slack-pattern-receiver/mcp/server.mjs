#!/usr/bin/env node
// Thin stdio MCP entry. The implementation is vendored in lib/ so the plugin
// stays self-contained when installed outside the POD repository.
import { mcpServer } from '../lib/slack-pattern-receiver.mjs';

mcpServer();
