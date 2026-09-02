把微信公众平台「开发管理 → 业务域名」下载的校验文件（形如 `MP_verify_xxxxxxxx.txt`）放到本目录，
执行 `npm run build:admin` 并部署后，即可通过 `https://admin.yuegui-hotel.online/MP_verify_xxxxxxxx.txt` 访问，
再回公众平台点「保存」完成校验。此目录下的文件会原样复制到构建产物根目录。
