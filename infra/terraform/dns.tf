resource "oci_dns_rrset" "api_a" {
  count           = var.create_dns_record ? 1 : 0
  zone_name_or_id = var.dns_zone_name
  domain          = trimsuffix(var.api_domain, ".")
  rtype           = "A"

  items {
    domain = trimsuffix(var.api_domain, ".")
    rdata  = oci_load_balancer_load_balancer.public.ip_addresses[0].ip_address
    rtype  = "A"
    ttl    = var.dns_ttl
  }
}
