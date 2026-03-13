module status_block (
    input wire clk,
    input wire rst,
    input wire uart_busy,
    input wire spi_busy,
    input wire packet_valid,
    output reg [7:0] status_code
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            status_code <= 8'd0;
        end else begin
            status_code <= {5'd0, packet_valid, spi_busy, uart_busy};
        end
    end
endmodule
