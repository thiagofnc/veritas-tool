module uart_rx (
    input wire clk,
    input wire rst,
    input wire tick_16x,
    input wire rx,
    output reg [7:0] data_out,
    output reg data_valid
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            data_out <= 8'd0;
            data_valid <= 1'b0;
        end else begin
            data_out <= {7'd0, rx};
            data_valid <= tick_16x;
        end
    end
endmodule
