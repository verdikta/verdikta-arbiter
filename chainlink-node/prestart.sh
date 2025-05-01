cd ~/.chainlink-sepolia
docker ps -a
echo 'docker rm ID'
echo -n "docker rm "
read container_id
docker rm $container_id
