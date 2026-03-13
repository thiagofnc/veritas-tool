module register_bank (
    input wire clk,
    input wire rst,
    input wire start,
    input wire [7:0] uart_rx_data,
    input wire uart_rx_valid,
    input wire [7:0] spi_rdata,
    input wire spi_done,
    input wire [7:0] i2c_rdata,
    input wire i2c_done,
    output reg [7:0] tx_data,
    output reg tx_start,
    output reg [7:0] spi_wdata,
    output reg spi_start,
    output reg [7:0] i2c_wdata,
    output reg i2c_start,
    output reg busy
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            tx_data <= 8'd0;
            tx_start <= 1'b0;
            spi_wdata <= 8'hA5;
            spi_start <= 1'b0;
            i2c_wdata <= 8'h3C;
            i2c_start <= 1'b0;
            busy <= 1'b0;
        end else begin
            tx_start <= start;
            spi_start <= start;
            i2c_start <= start;
            tx_data <= uart_rx_valid ? uart_rx_data : (spi_done ? spi_rdata : i2c_rdata);
            busy <= start | spi_done | i2c_done;
        end
    end
endmodule
