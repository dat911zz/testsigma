@echo off

echo Starting to build Front-end...
cd ../ui
set NODE_OPTIONS=--openssl-legacy-provider --max_old_space_size=4096
npx ng build --source-map --watch --configuration=docker