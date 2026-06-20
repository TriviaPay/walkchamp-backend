locals {
  compact_prefix = lower(substr(regexreplace(var.name_prefix, "[^a-zA-Z0-9]", ""), 0, 12))

  availability_domain = data.oci_identity_availability_domains.this.availability_domains[0].name
  bucket_name         = var.bucket_name != null ? var.bucket_name : "${var.name_prefix}-assets"

  enable_https = (
    var.lb_certificate_public_pem != null
    && var.lb_certificate_private_key_pem != null
  )

  redis_url = var.redis_url != null ? var.redis_url : "redis://127.0.0.1:6379"

  default_env = {
    NODE_ENV              = "production"
    PORT                  = tostring(var.app_port)
    APP_BASE_URL          = "${local.enable_https ? "https" : "http"}://${var.api_domain}"
    ALLOWED_ORIGINS       = join(",", var.allowed_origins)
    TRUST_PROXY_HOPS      = "1"
    ENABLE_RATE_LIMITING  = "true"
    REDIS_URL             = local.redis_url
    OCI_NAMESPACE         = data.oci_objectstorage_namespace.this.namespace
    OCI_REGION            = var.region
    OCI_BUCKET_NAME       = oci_objectstorage_bucket.assets.name
    OCI_ACCESS_KEY_ID     = var.oci_s3_access_key_id
    OCI_SECRET_ACCESS_KEY = var.oci_s3_secret_access_key
  }

  common_env = merge(local.default_env, var.application_env)
  api_env = merge(
    local.common_env,
    {
      APP_PROCESS_ROLE    = "api"
      RUN_BACKGROUND_JOBS = "false"
    },
    var.api_env_overrides,
  )
  worker_env = merge(
    local.common_env,
    {
      APP_PROCESS_ROLE    = "worker"
      RUN_BACKGROUND_JOBS = "true"
    },
    var.worker_env_overrides,
  )
  migrate_env = merge(
    local.common_env,
    {
      APP_PROCESS_ROLE    = "migration"
      RUN_BACKGROUND_JOBS = "false"
    },
    var.migrate_env_overrides,
  )

  api_env_content     = "${join("\n", [for key in sort(keys(local.api_env)) : "${key}=${replace(local.api_env[key], "\n", "")}"])}\n"
  worker_env_content  = "${join("\n", [for key in sort(keys(local.worker_env)) : "${key}=${replace(local.worker_env[key], "\n", "")}"])}\n"
  migrate_env_content = "${join("\n", [for key in sort(keys(local.migrate_env)) : "${key}=${replace(local.migrate_env[key], "\n", "")}"])}\n"

  api_unit_content    = "${trimspace(replace(file("${path.module}/../../deploy/systemd/walkchamp-api.service"), "\r\n", "\n"))}\n"
  worker_unit_content = "${trimspace(replace(file("${path.module}/../../deploy/systemd/walkchamp-worker.service"), "\r\n", "\n"))}\n"
  logrotate_content   = "${trimspace(replace(file("${path.module}/../../deploy/logrotate/walkchamp"), "\r\n", "\n"))}\n"

  theme_assets_root = "${path.module}/${var.theme_assets_dir}"
  theme_asset_files = setsubtract(fileset(local.theme_assets_root, "**"), toset([".gitkeep"]))
  theme_asset_mimes = {
    png  = "image/png"
    jpg  = "image/jpeg"
    jpeg = "image/jpeg"
    webp = "image/webp"
    gif  = "image/gif"
  }
  theme_asset_extensions = {
    for file_name in local.theme_asset_files :
    file_name => lower(element(reverse(split(".", file_name)), 0))
  }

  cloud_init = templatefile("${path.module}/templates/cloud-init.tftpl", {
    app_port              = var.app_port
    api_env_b64           = base64encode(local.api_env_content)
    worker_env_b64        = base64encode(local.worker_env_content)
    migrate_env_b64       = base64encode(local.migrate_env_content)
    api_unit_b64          = base64encode(local.api_unit_content)
    worker_unit_b64       = base64encode(local.worker_unit_content)
    logrotate_b64         = base64encode(local.logrotate_content)
    log_dir               = "/var/log/walkchamp"
    release_root          = "/srv/walkchamp/releases"
    release_id            = var.release_id
    enable_initial_deploy = var.enable_initial_deploy
    node_major_version    = var.node_major_version
    public_subnet_cidr    = var.public_subnet_cidr
    repo_clone_url        = var.repo_clone_url
    repo_ref              = var.repo_ref
    repo_ssh_host         = var.repo_ssh_host
    repo_deploy_key_b64   = var.repo_deploy_key_private != null ? base64encode(var.repo_deploy_key_private) : ""
    ssh_allowed_cidrs     = var.ssh_allowed_cidrs
  })
}
