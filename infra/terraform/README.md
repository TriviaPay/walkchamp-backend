# OCI Terraform Stack

This stack provisions a production-minimal OCI deployment for the backend:

- VCN
- public subnet
- NSGs and security list
- internet gateway and route table
- one compute VM
- one public OCI load balancer
- one private OCI Object Storage bucket
- folder-marker objects for:
  - `avatars/`
  - `group-images/`
  - `race-themes/`
- optional upload of local race-theme image assets
- cloud-init bootstrap for:
  - Node.js
  - Redis
  - logrotate
  - env files
  - systemd units
  - initial repo clone/build/migrate/startup

The Terraform defaults are now set to an OCI Always Free-safe baseline:

- `free_tier_mode = true`
- `instance_shape = VM.Standard.A1.Flex`
- `instance_ocpus = 2`
- `instance_memory_gbs = 8`
- `boot_volume_size_gbs = 50`
- one flexible load balancer fixed at `10 Mbps`
- `create_dns_record = false`

## Inputs

Copy [terraform.tfvars.example](/Users/rithiktheddu/Documents/TriviaPay/walkchamp-backend1/infra/terraform/terraform.tfvars.example) to `terraform.tfvars` and fill in real values.

Important:

- `instance_image_ocid` must point to a valid Ubuntu image in your OCI region.
- `availability_domain_name` can be set explicitly if OCI returns a host-capacity error in the default AD.
- `application_env` must include the app secrets and external provider config from `.env.example`.
- `oci_s3_access_key_id` and `oci_s3_secret_access_key` are still required because the current backend uses OCI's S3-compatible API.
- `repo_clone_url` must be reachable from the VM on first boot.
- If `enable_initial_deploy=true`, you must also provide `lb_certificate_public_pem` and `lb_certificate_private_key_pem`. The current backend rejects a non-HTTPS `APP_BASE_URL` in production.

## OCI Always Free Guardrails

When `free_tier_mode=true`, Terraform enforces these constraints:

- compute shape must be `VM.Standard.A1.Flex` or `VM.Standard.E2.1.Micro`
- A1 Flex stays within `2 OCPUs` and `12 GB` RAM
- boot volume stays at or below `50 GB`
- load balancer min/max bandwidth must both stay at `10 Mbps`
- OCI DNS creation is blocked

Recommended free-tier deployment for this app:

- `VM.Standard.A1.Flex`
- `2 OCPUs`
- `8 GB` RAM to start
- Cloudflare DNS with `create_dns_record=false`
- local Redis on the same VM

Do not use `VM.Standard.E2.1.Micro` for the main production API/worker host unless you are intentionally accepting a much weaker and less reliable setup.

## Theme assets

Place race theme images under:

```text
infra/terraform/theme-assets/
```

Examples:

```text
infra/terraform/theme-assets/bg.png
infra/terraform/theme-assets/forest.png
infra/terraform/theme-assets/underwater.png
```

These are uploaded automatically to:

```text
race-themes/<filename>
```

## Commands

```bash
cd infra/terraform
terraform init
terraform plan -out tfplan
terraform apply tfplan
```

Use Terraform `>= 1.5`. Terraform `1.5.0` works with the current configuration, but using a newer 1.x release is still preferable.

## Post-apply checks

Use the outputs:

- `instance_public_ip`
- `load_balancer_ip`
- `bucket_name`
- `api_base_url`
- `ssh_command`

Then verify:

```bash
curl https://your-api-domain/api/healthz
curl https://your-api-domain/api/readyz
curl -I https://your-api-domain/api/track-themes/bg/image
```

## Notes

- The stack installs Redis locally on the same VM and defaults `REDIS_URL` to `redis://127.0.0.1:6379`.
- If no load balancer certificate PEM/key is supplied, the stack can still create infra-only HTTP wiring, but `enable_initial_deploy=true` is blocked because the production app requires HTTPS.
- DNS record creation is optional and only runs when `create_dns_record=true`.
- For an Always Free deployment, leave `create_dns_record=false` and create the `api` record in Cloudflare manually or with the Cloudflare Terraform provider.
- If you use Cloudflare, start with `DNS only` so the current `TRUST_PROXY_HOPS=1` behavior remains aligned with the OCI load balancer path.
