variable "region" {
  description = "OCI region, for example us-ashburn-1."
  type        = string
}

variable "tenancy_ocid" {
  description = "OCI tenancy OCID. Required for availability-domain lookup."
  type        = string
}

variable "compartment_ocid" {
  description = "OCI compartment OCID that will own the stack resources."
  type        = string
}

variable "availability_domain_name" {
  description = "Optional OCI availability domain name override for the application VM, for example EYNM:US-CHICAGO-1-AD-2."
  type        = string
  default     = null
}

variable "name_prefix" {
  description = "Short prefix used for resource names."
  type        = string
}

variable "free_tier_mode" {
  description = "When true, enforce OCI Always Free-safe defaults and validation guards."
  type        = bool
  default     = true
}

variable "vcn_cidr" {
  description = "VCN CIDR block."
  type        = string
  default     = "10.42.0.0/16"
}

variable "public_subnet_cidr" {
  description = "Public subnet CIDR block used by the load balancer and VM."
  type        = string
  default     = "10.42.10.0/24"
}

variable "instance_image_ocid" {
  description = "OCI image OCID for ARM (aarch64) shapes such as VM.Standard.A1.Flex."
  type        = string
}

variable "instance_image_ocid_x86" {
  description = "OCI image OCID for x86-64 shapes such as VM.Standard.E2.1.Micro. Required only when instance_shape is an x86 shape."
  type        = string
  default     = null
}

variable "instance_shape" {
  description = "OCI compute shape."
  type        = string
  default     = "VM.Standard.A1.Flex"
}

variable "instance_ocpus" {
  description = "OCPU count for flex shapes."
  type        = number
  default     = 2
}

variable "instance_memory_gbs" {
  description = "Memory in GB for flex shapes."
  type        = number
  default     = 8
}

variable "boot_volume_size_gbs" {
  description = "Boot volume size in GB."
  type        = number
  default     = 50
}

variable "app_port" {
  description = "Backend application port exposed on the VM."
  type        = number
  default     = 8080
}

variable "ssh_authorized_keys" {
  description = "SSH public keys for the instance, newline-separated if multiple."
  type        = string
}

variable "ssh_allowed_cidrs" {
  description = "CIDR blocks allowed to SSH directly to the app VM."
  type        = list(string)
  default     = []
}

variable "api_domain" {
  description = "Public API domain served by the OCI load balancer."
  type        = string
}

variable "allowed_origins" {
  description = "Browser origins allowed by CORS."
  type        = list(string)
}

variable "bucket_name" {
  description = "Object Storage bucket name. If null, a name derived from name_prefix is used."
  type        = string
  default     = null
}

variable "oci_s3_access_key_id" {
  description = "OCI S3-compatible access key id for the application."
  type        = string
  sensitive   = true
}

variable "oci_s3_secret_access_key" {
  description = "OCI S3-compatible secret access key for the application."
  type        = string
  sensitive   = true
}

variable "application_env" {
  description = "Common application environment variables merged into api/worker/migrate env files."
  type        = map(string)
  sensitive   = true
}

variable "api_env_overrides" {
  description = "Additional or overriding API-only environment variables."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "worker_env_overrides" {
  description = "Additional or overriding worker-only environment variables."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "migrate_env_overrides" {
  description = "Additional or overriding migration-only environment variables."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "redis_url" {
  description = "Redis URL. Defaults to the local Redis instance installed on the app VM."
  type        = string
  default     = null
}

variable "repo_clone_url" {
  description = "Git clone URL for the backend repo. Can be public HTTPS, tokenized HTTPS, or SSH."
  type        = string
}

variable "repo_ref" {
  description = "Git branch or tag to clone for the initial deployment."
  type        = string
  default     = "main"
}

variable "repo_deploy_key_private" {
  description = "Optional private deploy key for SSH-based repo clones."
  type        = string
  default     = null
  sensitive   = true
}

variable "repo_ssh_host" {
  description = "SSH host used when repo_clone_url is SSH-based."
  type        = string
  default     = "github.com"
}

variable "release_id" {
  description = "Release directory name for the initial deployment."
  type        = string
  default     = "bootstrap"
}

variable "node_major_version" {
  description = "Node.js major version installed by cloud-init."
  type        = number
  default     = 22
}

variable "enable_initial_deploy" {
  description = "Whether cloud-init should clone, build, migrate, and start the app on first boot."
  type        = bool
  default     = true
}

variable "lb_min_bandwidth_mbps" {
  description = "Minimum flexible load balancer bandwidth."
  type        = number
  default     = 10
}

variable "lb_max_bandwidth_mbps" {
  description = "Maximum flexible load balancer bandwidth."
  type        = number
  default     = 10
}

variable "lb_certificate_public_pem" {
  description = "Optional public certificate PEM for HTTPS on the OCI load balancer."
  type        = string
  default     = null
  sensitive   = true
}

variable "lb_certificate_private_key_pem" {
  description = "Optional private key PEM for HTTPS on the OCI load balancer."
  type        = string
  default     = null
  sensitive   = true
}

variable "lb_certificate_ca_pem" {
  description = "Optional certificate chain PEM for HTTPS on the OCI load balancer."
  type        = string
  default     = null
  sensitive   = true
}

variable "create_dns_record" {
  description = "Whether to create an OCI DNS A record for api_domain."
  type        = bool
  default     = false
}

variable "dns_zone_name" {
  description = "OCI DNS zone name or OCID. Required when create_dns_record=true."
  type        = string
  default     = null
}

variable "dns_ttl" {
  description = "TTL for the optional OCI DNS record."
  type        = number
  default     = 300
}

variable "theme_assets_dir" {
  description = "Directory under infra/terraform containing race theme images to upload into the bucket."
  type        = string
  default     = "theme-assets"
}

variable "freeform_tags" {
  description = "Freeform tags applied to supported resources."
  type        = map(string)
  default     = {}
}
