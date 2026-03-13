module uart_tx (
    input wire clk,
    input wire rst,
    input wire tick_16x,
    input wire [7:0] data_in,
    input wire start,
    output reg tx
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            tx <= 1'b1;
        end else if (start && tick_16x) begin
            tx <= data_in[0];
        end else begin
            tx <= 1'b1;
        end
    end
endmodule
