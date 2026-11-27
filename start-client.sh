#!/bin/sh
# 前台启动 rpty 客户端（开发方式运行，不装 .app）
cd /Users/zhaojian/rpty || exit 1
exec ./apps/desktop/node_modules/.bin/electron ./apps/desktop "$@"
