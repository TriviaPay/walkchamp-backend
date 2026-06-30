data "oci_objectstorage_namespace" "this" {
  compartment_id = var.compartment_ocid
}

resource "oci_objectstorage_bucket" "assets" {
  compartment_id = var.compartment_ocid
  namespace      = data.oci_objectstorage_namespace.this.namespace
  name           = local.bucket_name
  access_type    = "NoPublicAccess"
  storage_tier   = "Standard"
  freeform_tags  = var.freeform_tags
}

resource "oci_objectstorage_object" "prefixes" {
  for_each     = toset(["avatars/", "group-images/", "race-themes/"])
  namespace    = data.oci_objectstorage_namespace.this.namespace
  bucket       = oci_objectstorage_bucket.assets.name
  object       = each.value
  content      = ""
  content_type = "application/x-directory"
}

resource "oci_objectstorage_object" "theme_assets" {
  for_each     = local.theme_asset_files
  namespace    = data.oci_objectstorage_namespace.this.namespace
  bucket       = oci_objectstorage_bucket.assets.name
  object       = "race-themes/${replace(each.value, "\\", "/")}"
  source       = "${local.theme_assets_root}/${each.value}"
  content_type = lookup(local.theme_asset_mimes, local.theme_asset_extensions[each.value], "application/octet-stream")
}
