module expand_stage (
    input wire clk,
    input wire rst,
    input wire [7:0] in_a,
    input wire [7:0] in_b,
    output reg [7:0] out0,
    output reg [7:0] out1,
    output reg [7:0] out2,
    output reg [7:0] out3,
    output reg valid_out
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            out0 <= 8'd0;
            out1 <= 8'd0;
            out2 <= 8'd0;
            out3 <= 8'd0;
            valid_out <= 1'b0;
        end else begin
            out0 <= in_a;
            out1 <= in_b;
            out2 <= in_a + in_b;
            out3 <= in_a - in_b;
            valid_out <= 1'b1;
        end
    end
endmodule
