module spi_master (
    input wire clk,
    input wire rst,
    input wire start,
    input wire [7:0] data_in,
    input wire miso,
    output reg sclk,
    output reg mosi,
    output reg cs_n,
    output reg [7:0] data_out,
    output reg done
);
    always @(posedge clk or posedge rst) begin
        if (rst) begin
            sclk <= 1'b0;
            mosi <= 1'b0;
            cs_n <= 1'b1;
            data_out <= 8'd0;
            done <= 1'b0;
        end else begin
            cs_n <= ~start;
            sclk <= clk & start;
            mosi <= data_in[7];
            data_out <= {7'd0, miso};
            done <= start;
        end
    end
endmodule
