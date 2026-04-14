module line_top (
    input wire clk,
    input wire rst,
    input wire en,
    input wire [7:0] seed,
    output wire [7:0] sum_out,
    output wire valid_out
);
    wire [7:0] stage1_a;
    wire [7:0] stage1_b;
    wire [7:0] fan0;
    wire [7:0] fan1;
    wire [7:0] fan2;
    wire [7:0] fan3;
    wire mid_valid;

    line_source u_source (
        .clk(clk),
        .rst(rst),
        .en(en),
        .seed(seed),
        .sig_a(stage1_a),
        .sig_b(stage1_b)
    );

    expand_stage u_expand (
        .clk(clk),
        .rst(rst),
        .in_a(stage1_a),
        .in_b(stage1_b),
        .out0(fan0),
        .out1(fan1),
        .out2(fan2),
        .out3(fan3),
        .valid_out(mid_valid)
    );

    sink_stage u_sink (
        .clk(clk),
        .rst(rst),
        .in0(fan0),
        .in1(fan1),
        .in2(fan2),
        .in3(fan3),
        .valid_in(mid_valid),
        .sum_out(sum_out),
        .valid_out(valid_out)
    );

  new_module new_module_inst (
    .input1(),
    .input2(),
    .output1()
  );

endmodule
