module line_source (
    input wire clk,
    input wire rst,
    input wire en,
    input wire [7:0] seed,
    output reg [7:0] sig_a,
    output reg [7:0] sig_b
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            sig_a <= 8'd0;
            sig_b <= 8'd0;
        end else if (en) begin
            sig_a <= seed + 8'd1;
            sig_b <= seed + 8'd2;
        end
    end
endmodule
