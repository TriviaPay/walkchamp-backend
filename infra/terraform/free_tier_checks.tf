check "free_tier_constraints" {
  assert {
    condition = (
      !var.free_tier_mode
      || contains(["VM.Standard.A1.Flex", "VM.Standard.E2.1.Micro"], var.instance_shape)
    )
    error_message = "free_tier_mode only allows VM.Standard.A1.Flex or VM.Standard.E2.1.Micro."
  }

  assert {
    condition = (
      !var.free_tier_mode
      || var.instance_shape != "VM.Standard.A1.Flex"
      || (var.instance_ocpus > 0 && var.instance_ocpus <= 2)
    )
    error_message = "In free_tier_mode, VM.Standard.A1.Flex must stay within the Always Free 2 OCPU allowance."
  }

  assert {
    condition = (
      !var.free_tier_mode
      || var.instance_shape != "VM.Standard.A1.Flex"
      || (var.instance_memory_gbs > 0 && var.instance_memory_gbs <= 12)
    )
    error_message = "In free_tier_mode, VM.Standard.A1.Flex must stay within the Always Free 12 GB memory allowance."
  }

  assert {
    condition = (
      !var.free_tier_mode
      || (var.boot_volume_size_gbs > 0 && var.boot_volume_size_gbs <= 50)
    )
    error_message = "In free_tier_mode, keep the boot volume at or below 50 GB so the stack stays comfortably within OCI Always Free storage limits."
  }

  assert {
    condition     = !var.free_tier_mode || var.lb_min_bandwidth_mbps == 10
    error_message = "free_tier_mode requires the OCI flexible load balancer minimum bandwidth to be exactly 10 Mbps."
  }

  assert {
    condition     = !var.free_tier_mode || var.lb_max_bandwidth_mbps == 10
    error_message = "free_tier_mode requires the OCI flexible load balancer maximum bandwidth to be exactly 10 Mbps."
  }

  assert {
    condition     = !var.free_tier_mode || var.create_dns_record == false
    error_message = "OCI DNS is not Always Free-safe. Set create_dns_record=false when free_tier_mode=true."
  }
}
