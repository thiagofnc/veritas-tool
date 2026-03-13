module spi_bridge (
    input wire clk,
    input wire rst,
    input wire enable,
    input wire [7:0] data_in,
    input wire spi_miso,
    output reg spi_sclk,
    output reg spi_mosi,
    output reg spi_cs_n,
    output reg busy,
    output reg [7:0] status
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            spi_sclk <= 1'b0;
            spi_mosi <= 1'b0;
            spi_cs_n <= 1'b1;
            busy <= 1'b0;
            status <= 8'd0;
        end else begin
            spi_sclk <= clk & enable;
            spi_mosi <= data_in[7];
            spi_cs_n <= ~enable;
            busy <= enable;
            status <= {7'd0, spi_miso};
        end
    end
endmodule
