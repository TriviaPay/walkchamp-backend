resource "oci_core_instance" "app" {
  availability_domain = local.availability_domain
  compartment_id      = var.compartment_ocid
  display_name        = "${var.name_prefix}-app"
  shape               = var.instance_shape
  freeform_tags       = var.freeform_tags

  shape_config {
    ocpus         = var.instance_ocpus
    memory_in_gbs = var.instance_memory_gbs
  }

  create_vnic_details {
    subnet_id        = oci_core_subnet.public.id
    assign_public_ip = true
    nsg_ids          = [oci_core_network_security_group.app.id]
    display_name     = "${var.name_prefix}-app-vnic"
    hostname_label   = "${local.compact_prefix}app"
  }

  source_details {
    source_type             = "image"
    source_id               = var.instance_image_ocid
    boot_volume_size_in_gbs = var.boot_volume_size_gbs
  }

  metadata = {
    ssh_authorized_keys = var.ssh_authorized_keys
    user_data           = base64encode(local.cloud_init)
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
