resource "oci_core_instance" "app" {
  availability_domain = local.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "${var.name_prefix}-app"
  shape               = var.instance_shape
  freeform_tags       = var.freeform_tags

  # Flex shapes (A1.Flex) require shape_config; fixed shapes (E2.1.Micro) reject it.
  dynamic "shape_config" {
    for_each = local.instance_is_flex ? [1] : []
    content {
      ocpus         = var.instance_ocpus
      memory_in_gbs = var.instance_memory_gbs
    }
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    nsg_ids          = [oci_core_network_security_group.app.id]
    display_name     = "${var.name_prefix}-app-vnic"
    hostname_label   = "${local.compact_prefix}app${local.instance_hostname_suffix}"
  }

  source_details {
    source_type             = "image"
    source_id               = local.instance_image
    boot_volume_size_in_gbs = var.boot_volume_size_gbs
  }

  metadata = {
    ssh_authorized_keys = var.ssh_authorized_keys
    user_data           = base64encode(local.cloud_init)
  }

  # Provision the replacement instance before tearing down the old one so the
  # A1 hunt never leaves you without a running VM. Combined with the per-arch
  # hostname_label, the new A1 and the existing micro can coexist briefly.
  lifecycle {
    create_before_destroy = true
  }
}

data "oci_core_vnic_attachments" "app" {
  compartment_id      = var.compartment_ocid
  availability_domain = local.availability_domain
  instance_id         = oci_core_instance.app.id
}

data "oci_core_vnic" "app_primary" {
  vnic_id = data.oci_core_vnic_attachments.app.vnic_attachments[0].vnic_id
}
