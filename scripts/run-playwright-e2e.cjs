#!/usr/bin/env node

process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
require("@playwright/test/cli");
