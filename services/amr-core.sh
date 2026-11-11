#!/bin/bash
# 跑 pkg 打包好的執行檔 (yarn build && yarn build_pkg 產生的 build/amr-core-linux)
# 不需要 node / nvm / yarn; config/ 跟 .env 要放在 /home/kenmec/amr-core 底下

# 保留: 環境變數 (例如 NODE_CONFIG_ENV) 可能設在 .bashrc
source /home/kenmec/.bashrc

cd /home/kenmec/amr-core
# exec: 讓 systemd 直接管這個程序, stop/restart 的訊號才會送到 amr-core
exec ./amr-core-linux
