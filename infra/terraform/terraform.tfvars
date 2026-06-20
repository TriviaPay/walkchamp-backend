region           = "us-chicago-1"
tenancy_ocid     = "ocid1.tenancy.oc1..aaaaaaaa53wysykg3qbzfw5myatqg5x3wn3bfps52xbrdqavmer6ame5rg2a"
compartment_ocid = "ocid1.compartment.oc1..aaaaaaaacgjqkq552jhaztjawljirhi6lxw7p7wsquwnbrtnfappt2dffnca"
name_prefix      = "walkchamp-prod"
free_tier_mode   = true

instance_image_ocid = "ocid1.image.oc1.us-chicago-1.aaaaaaaa3yn6ge4bv3vl7hxkh2uof5dw2wz5potswwekneudwrolkjpksnwq"
instance_shape      = "VM.Standard.A1.Flex"
instance_ocpus      = 2
instance_memory_gbs = 8
boot_volume_size_gbs = 50

ssh_authorized_keys = <<EOF
ssh-ed25519 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFrtkkBaNu/JvjmB3zA7RBcRD+ODd22GrDJZc6re0iNQ walkchamp
EOF

ssh_allowed_cidrs = [
  "35.141.66.89/32",
]

api_domain = "api.walkchamp.miragaming.com"
allowed_origins = [
  "https://walkchamp.miragaming.com",
]

bucket_name               = "walkchamp"
oci_s3_access_key_id      = "walkchamp-s3"
oci_s3_secret_access_key  = "VE1ylfhNWgBWaZL2XHUgVbsWllSCUrPkZmy00hUQaQs="

repo_clone_url = "git@github.com:TriviaPay/walkchamp-backend1.git"
repo_ref       = "main"
repo_ssh_host  = "github.com"
repo_deploy_key_private = <<EOF
-----BEGIN OPENSSH PRIVATE KEY-----
...
-----END OPENSSH PRIVATE KEY-----
EOF

release_id = "2026-06-19-prod-bootstrap"

application_env = {
  DATABASE_RUNTIME_URL      = "postgres://..."
  DATABASE_ADMIN_URL        = "postgres://..."
  DESCOPE_PROJECT_ID        = "..."
  DESCOPE_MANAGEMENT_KEY    = "..."
  SESSION_SECRET            = "..."
  STRIPE_SECRET_KEY         = "..."
  STRIPE_WEBHOOK_SECRET     = "..."
  RAZORPAY_KEY_ID           = "..."
  RAZORPAY_KEY_SECRET       = "..."
  RAZORPAY_WEBHOOK_SECRET   = "..."
  LIVEKIT_URL               = "wss://..."
  LIVEKIT_API_KEY           = "..."
  LIVEKIT_API_SECRET        = "..."
  SENTRY_DSN                = "..."
  SENTRY_ENVIRONMENT        = "production"
  CASH_FEATURES_ENABLED     = "true"
  FEATURE_CASH_FEATURES     = "true"
  PUSHER_APP_ID             = "..."
  PUSHER_KEY                = "..."
  PUSHER_SECRET             = "..."
  PUSHER_CLUSTER            = "..."
  ONESIGNAL_APP_ID          = "..."
  ONESIGNAL_REST_API_KEY    = "..."
  ADMIN_API_KEY             = "..."
  ADMIN_SERVICE_KEY         = "..."
  ADMIN_USER_IDS            = "user1,user2"
}

create_dns_record = false
# dns_zone_name   = "example.com"

# Optional: if you already have a cert PEM/key pair and want HTTPS on first apply.
# lb_certificate_public_pem = <<EOF
# -----BEGIN CERTIFICATE-----
# ...
# -----END CERTIFICATE-----
# EOF
#
# lb_certificate_private_key_pem = <<EOF
# -----BEGIN PRIVATE KEY-----
# ...
# -----END PRIVATE KEY-----
# EOF

# Always Free-safe expectations:
# - leave create_dns_record=false and manage DNS in Cloudflare or another external DNS provider
# - keep the load balancer at 10 Mbps min/max
# - keep Object Storage usage small enough to remain inside your tenancy's Always Free quota
