output "vcn_id" {
  value = oci_core_virtual_network.this.id
}

output "subnet_id" {
  value = oci_core_subnet.public.id
}

output "instance_id" {
  value = oci_core_instance.app.id
}

output "instance_public_ip" {
  value = data.oci_core_vnic.app_primary.public_ip_address
}

output "instance_private_ip" {
  value = data.oci_core_vnic.app_primary.private_ip_address
}

output "load_balancer_ip" {
  value = oci_load_balancer_load_balancer.public.ip_addresses[0].ip_address
}

output "listener_port" {
  value = local.enable_https ? 443 : 80
}

output "api_base_url" {
  value = "${local.enable_https ? "https" : "http"}://${var.api_domain}"
}

output "bucket_name" {
  value = oci_objectstorage_bucket.assets.name
}

output "bucket_namespace" {
  value = data.oci_objectstorage_namespace.this.namespace
}

output "ssh_command" {
  value = "ssh ubuntu@${data.oci_core_vnic.app_primary.public_ip_address}"
}
