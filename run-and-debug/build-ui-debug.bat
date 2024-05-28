@echo off

echo Starting to build Front-end...
cd ../ui
set NODE_OPTIONS=--openssl-legacy-provider
npx ng build --source-map --configuration=docker
