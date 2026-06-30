resource "oci_load_balancer_load_balancer" "public" {
  compartment_id             = var.compartment_ocid
  display_name               = "${var.name_prefix}-lb"
  shape                      = "flexible"
  subnet_ids                 = [oci_core_subnet.public.id]
  network_security_group_ids = [oci_core_network_security_group.lb.id]
  is_private                 = false
  freeform_tags              = var.freeform_tags

  shape_details {
    minimum_bandwidth_in_mbps = var.lb_min_bandwidth_mbps
    maximum_bandwidth_in_mbps = var.lb_max_bandwidth_mbps
  }
}

resource "oci_load_balancer_backend_set" "app" {
  health_checker {
    protocol          = "HTTP"
    port              = var.app_port
    url_path          = "/api/healthz"
    return_code       = 200
    interval_ms       = 10000
    timeout_in_millis = 3000
    retries           = 3
  }

  load_balancer_id = oci_load_balancer_load_balancer.public.id
  name             = "${var.name_prefix}-app-bs"
  policy           = "ROUND_ROBIN"
}

resource "oci_load_balancer_backend" "app" {
  load_balancer_id = oci_load_balancer_load_balancer.public.id
  backendset_name  = oci_load_balancer_backend_set.app.name
  ip_address       = data.oci_core_vnic.app_primary.private_ip_address
  port             = var.app_port
  backup           = false
  drain            = false
  offline          = false
  weight           = 1
}

resource "oci_load_balancer_certificate" "https" {
  count              = local.enable_https ? 1 : 0
  load_balancer_id   = oci_load_balancer_load_balancer.public.id
  certificate_name   = "${var.name_prefix}-https-cert"
  private_key        = var.lb_certificate_private_key_pem
  public_certificate = var.lb_certificate_public_pem
  ca_certificate     = var.lb_certificate_ca_pem
}

resource "oci_load_balancer_listener" "app" {
  load_balancer_id         = oci_load_balancer_load_balancer.public.id
  default_backend_set_name = oci_load_balancer_backend_set.app.name
  name                     = local.enable_https ? "${var.name_prefix}-https" : "${var.name_prefix}-http"
  port                     = local.enable_https ? 443 : 80
  protocol                 = "HTTP"

  connection_configuration {
    idle_timeout_in_seconds = 120
  }

  dynamic "ssl_configuration" {
    for_each = local.enable_https ? [1] : []
    content {
      certificate_name = oci_load_balancer_certificate.https[0].certificate_name
    }
  }

  lifecycle {
    precondition {
      condition     = !var.enable_initial_deploy || local.enable_https
      error_message = "lb_certificate_public_pem and lb_certificate_private_key_pem are required when enable_initial_deploy=true because the production app requires an HTTPS APP_BASE_URL."
    }
  }
}
