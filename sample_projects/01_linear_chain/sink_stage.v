module sink_stage (
    input wire clk,
    input wire rst,
    input wire [7:0] in0,
    input wire [7:0] in1,
    input wire [7:0] in2,
    input wire [7:0] in3,
    input wire valid_in,
    output reg [7:0] sum_out,
    output reg valid_out
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            sum_out <= 8'd0;
            valid_out <= 1'b0;
        end else begin
            sum_out <= in0 + in1 + in2 + in3;
            valid_out <= valid_in;
        end
    end
endmodule
