#!/bin/bash

# Set the root folder
ROOT_FOLDER=$(pwd)
CURRENT_DIR=$(pwd)

# # Build the automator module
echo "[+] Build automator module"
cd $ROOT_FOLDER/automator
mvn clean install || { echo "Build failed for automator"; exit 1; }

# Build the agent module
echo "[+] Build agent module"
cd $ROOT_FOLDER/agent
mvn install || { echo "Build failed for agent"; exit 1; }

# Build the agent-launcher module
echo "[+] Build agent-launcher module"
cd $ROOT_FOLDER/agent-launcher
mvn install || { echo "Build failed for agent-launcher"; exit 1; }

# Update application.properties for local agent download tag
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' -e "s/local.agent.download.tag=latest/local.agent.download.tag=$LOCAL_AGENT_TAG/g" $ROOT_FOLDER/server/src/main/resources/application.properties
else
  sed -i "s/local.agent.download.tag=latest/local.agent.download.tag=$LOCAL_AGENT_TAG/g" $ROOT_FOLDER/server/src/main/resources/application.properties
fi

# Revert application.properties changes
if [[ "$OSTYPE" == "darwin"* ]]; then
  sed -i '' -e "s/local.agent.download.tag=$LOCAL_AGENT_TAG/local.agent.download.tag=latest/g" $ROOT_FOLDER/server/src/main/resources/application.properties
else
  sed -i "s/local.agent.download.tag=$LOCAL_AGENT_TAG/local.agent.download.tag=latest/g" $ROOT_FOLDER/server/src/main/resources/application.properties
fi

# Return to the initial directory
cd $CURRENT_DIR

echo "Copy files"
cp -f $ROOT_FOLDER/agent-launcher/target/agent-launcher.jar $ROOT_FOLDER
cp -f $ROOT_FOLDER/agent/target/agent.jar $ROOT_FOLDER

echo "Copy folders"
cp -ru $ROOT_FOLDER/agent/target/lib/ $ROOT_FOLDER

echo "Build completed successfully."
exit 0