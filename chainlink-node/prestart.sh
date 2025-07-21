# Find the correct chainlink directory
for dir in ~/.chainlink-testnet ~/.chainlink-mainnet ~/.chainlink-sepolia; do
    if [ -d "$dir" ]; then
        cd "$dir"
        break
    fi
done
docker ps -a
echo 'docker rm ID'
echo -n "docker rm "
read container_id
docker rm $container_id
