module tracer_validation_top (
    input  wire trace_start_full_path_alpha_in,
    input  wire trace_start_mid_entry_beta_in,
    input  wire trace_start_shared_branch_gamma_in,
    input  wire trace_start_register_delta_in,
    input  wire trace_clk,
    output wire trace_finish_full_path_alpha_out,
    output wire trace_finish_mid_entry_beta_out,
    output wire trace_finish_shared_branch_gamma_out,
    output wire trace_finish_register_delta_out
);
  // Full path: source -> launch -> middle -> finish
  wire trace_path_full_alpha_after_launch;
  wire trace_path_full_alpha_after_middle;

  // Begins in the middle of the design but still reaches a finish output.
  wire trace_path_mid_beta_visible_in_middle;
  wire trace_path_mid_beta_after_middle;

  // Begins in the middle, fans out, and one branch intentionally dies.
  wire trace_path_shared_gamma_split_source;
  wire trace_path_shared_gamma_finish_branch;
  wire trace_path_shared_gamma_dead_end_branch;

  // Sequential path to exercise the SEQUENTIAL trace role.
  wire trace_path_register_delta_comb_source;
  wire trace_path_register_delta_registered_q;

  tracer_launch_stage u_launch_stage (
      .trace_start_full_path_alpha_in(trace_start_full_path_alpha_in),
      .trace_start_mid_entry_beta_in(trace_start_mid_entry_beta_in),
      .trace_start_shared_branch_gamma_in(trace_start_shared_branch_gamma_in),
      .trace_start_register_delta_in(trace_start_register_delta_in),
      .trace_path_full_alpha_after_launch(trace_path_full_alpha_after_launch),
      .trace_path_mid_beta_visible_in_middle(trace_path_mid_beta_visible_in_middle),
      .trace_path_shared_gamma_split_source(trace_path_shared_gamma_split_source),
      .trace_path_register_delta_comb_source(trace_path_register_delta_comb_source)
  );

  tracer_middle_stage u_middle_stage (
      .trace_path_full_alpha_after_launch(trace_path_full_alpha_after_launch),
      .trace_path_mid_beta_visible_in_middle(trace_path_mid_beta_visible_in_middle),
      .trace_path_shared_gamma_split_source(trace_path_shared_gamma_split_source),
      .trace_path_register_delta_comb_source(trace_path_register_delta_comb_source),
      .trace_clk(trace_clk),
      .trace_path_full_alpha_after_middle(trace_path_full_alpha_after_middle),
      .trace_path_mid_beta_after_middle(trace_path_mid_beta_after_middle),
      .trace_path_shared_gamma_finish_branch(trace_path_shared_gamma_finish_branch),
      .trace_path_shared_gamma_dead_end_branch(trace_path_shared_gamma_dead_end_branch),
      .trace_path_register_delta_registered_q(trace_path_register_delta_registered_q)
  );

  tracer_finish_stage u_finish_stage (
      .trace_path_full_alpha_after_middle(trace_path_full_alpha_after_middle),
      .trace_path_mid_beta_after_middle(trace_path_mid_beta_after_middle),
      .trace_path_shared_gamma_finish_branch(trace_path_shared_gamma_finish_branch),
      .trace_path_shared_gamma_dead_end_branch(trace_path_shared_gamma_dead_end_branch),
      .trace_path_register_delta_registered_q(trace_path_register_delta_registered_q),
      .trace_finish_full_path_alpha_out(trace_finish_full_path_alpha_out),
      .trace_finish_mid_entry_beta_out(trace_finish_mid_entry_beta_out),
      .trace_finish_shared_branch_gamma_out(trace_finish_shared_branch_gamma_out),
      .trace_finish_register_delta_out(trace_finish_register_delta_out)
  );
endmodule
