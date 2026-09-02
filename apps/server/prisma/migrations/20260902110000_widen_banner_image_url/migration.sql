-- COS 自定义域名 + 分月目录后的 URL 可能超过 255，与其他图片字段统一为 500
ALTER TABLE `banners` MODIFY `image_url` VARCHAR(500) NOT NULL;
