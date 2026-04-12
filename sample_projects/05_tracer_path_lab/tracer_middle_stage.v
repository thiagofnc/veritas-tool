module tracer_middle_stage (
    input  wire trace_path_full_alpha_after_launch,
    input  wire trace_path_mid_beta_visible_in_middle,
    input  wire trace_path_shared_gamma_split_source,
    input  wire trace_path_register_delta_comb_source,
    input  wire trace_clk,
    output wire trace_path_full_alpha_after_middle,
    output wire trace_path_mid_beta_after_middle,
    output wire trace_path_shared_gamma_finish_branch,
    output wire trace_path_shared_gamma_dead_end_branch,
    output reg  trace_path_register_delta_registered_q
);
  // Full-path combinational transform.
  assign trace_path_full_alpha_after_middle =
      trace_path_full_alpha_after_launch;

  // Mid-visible path that still reaches the finish stage.
  assign trace_path_mid_beta_after_middle =
      trace_path_mid_beta_visible_in_middle;

  // Shared source that splits into one useful branch and one dead-end branch.
  assign trace_path_shared_gamma_finish_branch =
      trace_path_shared_gamma_split_source;
  assign trace_path_shared_gamma_dead_end_branch =
      trace_path_shared_gamma_split_source;

  // Sequential handoff to test the SEQUENTIAL trace category.
  always @(posedge trace_clk) begin
    trace_path_register_delta_registered_q <= trace_path_register_delta_comb_source;
  end
endmodule
