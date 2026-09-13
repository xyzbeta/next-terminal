#!/bin/bash

cp build/resources/logo.png web/src/images/logo.png
cp build/resources/logo-with-name.png web/src/images/logo-with-name.png
cp build/resources/favicon.ico web/public/favicon.ico

rm -rf server/resource/build
echo "clean build history"

echo "build web..."
cd web || exit
yarn build || exit
cp -r build ../server/resource/
# 剔除 sourcemap：CRA 生产默认生成 source-map，本项目未设 GENERATE_SOURCEMAP，
# 实测 81 个 .map 共约 30MB，会经 //go:embed 打进二进制并由 /static/* 匿名可下载，
# 等于公开全部前端源码（含鉴权头组织方式）。web/build 内保留备份供本地调试。
find ../server/resource/build -name '*.map' -delete
echo "build web success"

echo "build api..."
cd ..
go mod tidy
go env;CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags '-s -w' -o next-terminal main.go
upx next-terminal

rm -rf server/resource/build
echo "build api success"