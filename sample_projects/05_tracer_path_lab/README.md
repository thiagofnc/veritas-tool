# Tracer Path Lab

This bundled project is designed to exercise the current tracer behavior.

Recommended trace targets:

- `trace_start_full_path_alpha_in`
  Expected: reaches `trace_finish_full_path_alpha_out`
- `trace_path_full_alpha_after_launch`
  Expected: appears in the middle and reaches the finish
- `trace_path_mid_beta_visible_in_middle`
  Expected: starts in the middle and reaches `trace_finish_mid_entry_beta_out`
- `trace_path_shared_gamma_split_source`
  Expected: fans out into one finish branch and one dead-end branch
- `trace_path_shared_gamma_dead_end_branch`
  Expected: appears in the middle and stops inside `tracer_finish_stage`
- `trace_path_register_delta_comb_source`
  Expected: crosses a sequential register hop before reaching `trace_finish_register_delta_out`
- `trace_path_register_delta_registered_q`
  Expected: starts after the sequential hop and reaches the finish

This sample is useful for checking:

- cross-module transport tracing
- middle-of-path retracing
- fanout rendering
- dead-end detection
- sequential hop labeling
